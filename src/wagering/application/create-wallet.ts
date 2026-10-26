import { Money, type MoneyProps } from "@/shared/domain/money";
import { uuidv7 } from "@/shared/domain/uuid";
import type { Logger } from "@/shared/observability/logger";
import { WalletBalanceChanged } from "../domain/events/wagering-events";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { InvalidRequestError, UniqueViolationError, WalletAlreadyExistsError } from "./errors";
import type { UnitOfWork } from "./ports";

export interface CreateWalletCommand {
  playerId: unknown;
  initialBalance: unknown;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const { playerId, initialBalance } = this.parse(command);
    const now = this.clock();
    const openingTransactionId = uuidv7(now.getTime());
    const { wallet, openingEntry } = Wallet.open({ playerId, initialBalance, openingTransactionId, now });

    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.insert(wallet);
        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId,
            money: initialBalance,
            at: now,
          });
          await repos.transactions.insert(opening, { correlationId: command.correlationId });
          await repos.ledger.append(openingEntry);
          await repos.outbox.enqueue([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, { correlationId: command.correlationId, occurredAt: now }),
            ),
          ]);
        }
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      throw error;
    }

    this.logger.info("wallet created", { correlationId: command.correlationId, walletId: wallet.id });
    return toWalletView(wallet);
  }

  private parse(command: CreateWalletCommand): { playerId: string; initialBalance: Money } {
    const { playerId, initialBalance } = command;
    if (typeof playerId !== "string" || playerId.trim() === "" || playerId.length > 128) {
      throw new InvalidRequestError("playerId must be a non-empty string (max 128 chars)");
    }
    if (!initialBalance || typeof initialBalance !== "object") {
      throw new InvalidRequestError("initialBalance must be an object { amount, currency }");
    }
    return { playerId, initialBalance: Money.from(initialBalance as MoneyProps) };
  }
}
