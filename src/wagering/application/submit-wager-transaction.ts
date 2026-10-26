import { Money, type MoneyProps } from "@/shared/domain/money";
import type { Logger } from "@/shared/observability/logger";
import { FailureCode } from "../domain/failure-code";
import { InboxMessage } from "../domain/inbox-message";
import { computeWagerPayloadHash, type WagerBusinessFields } from "../domain/wager-payload-hash";
import { WagerTransaction } from "../domain/wager-transaction";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  UnprocessableTransactionError,
} from "./errors";
import type { TransactionSource, WageringMetrics } from "./metrics";
import type { Repositories, UnitOfWork } from "./ports";
import { isUniqueViolation, withTransientRetry } from "./transient-retry";
import { settleAndPersist, toWagerResult, type WagerResult } from "./wager-processing";

export interface WagerTransactionPayload {
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: unknown;
  referenceExternalTransactionId?: unknown;
}

export interface SubmitWagerCommand {
  idempotencyKey: unknown;
  payload: WagerTransactionPayload;
  source: TransactionSource;
  correlationId: string;
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerOutcome extends WagerResult {
  duplicateMessage?: boolean;
}

const MAX_KEY_LENGTH = 256;

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerOutcome> {
    const started = performance.now();
    const { fields, idempotencyKey } = this.parse(command);
    const payloadHash = computeWagerPayloadHash(fields);
    const log = this.logger.child({
      correlationId: command.correlationId,
      providerId: fields.providerId,
      walletId: fields.walletId,
      externalTransactionId: fields.externalTransactionId,
      ...(command.inbox ? { messageId: command.inbox.messageId } : {}),
    });

    const outcome = await withTransientRetry(
      () => this.uow.run((repos) => this.attempt(repos, command, fields, idempotencyKey, payloadHash)),
      {
        operation: "submit_wager_transaction",
        maxAttempts: 4,
        baseDelayMs: 15,
        metrics: this.metrics,
        // corrida na UNIQUE: a nova tentativa encontra a transação que venceu e responde replay
        retryOn: isUniqueViolation,
      },
    );

    if (outcome.idempotentReplay) this.metrics.duplicateDetected("idempotency_replay");
    if (outcome.duplicateMessage) this.metrics.duplicateDetected("inbox_redelivery");
    this.metrics.transactionOutcome(outcome.status, fields.kind, command.source);
    this.metrics.processingLatency(command.source, (performance.now() - started) / 1000);
    log.info("wager transaction handled", {
      transactionId: outcome.transactionId,
      kind: fields.kind,
      status: outcome.status,
      failureCode: outcome.failureCode,
      idempotentReplay: outcome.idempotentReplay,
      duplicateMessage: outcome.duplicateMessage ?? false,
    });
    return outcome;
  }

  private async attempt(
    repos: Repositories,
    command: SubmitWagerCommand,
    fields: WagerBusinessFields,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SubmitWagerOutcome> {
    const now = this.clock();

    // trava a wallet antes de checar a idempotência: duplicatas concorrentes entram em fila e a segunda já enxerga a primeira
    const wallet = await repos.wallets.lockById(fields.walletId);

    if (command.inbox) {
      const fresh = await repos.inbox.tryReceive(
        InboxMessage.receive({ ...command.inbox, payloadHash, receivedAt: now }),
      );
      if (!fresh) {
        const original = await repos.transactions.findByIdempotencyKey(fields.providerId, idempotencyKey);
        if (!original) {
          throw new InvalidRequestError(`message ${command.inbox.messageId} was already handled without a transaction`);
        }
        return { ...toWagerResult(original, true, wallet?.balance.toJSON()), duplicateMessage: true };
      }
    }

    const existing = await repos.transactions.findByIdempotencyKey(fields.providerId, idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(fields.providerId, idempotencyKey, existing.id);
      }
      return toWagerResult(existing, true, wallet?.balance.toJSON());
    }
    const sameExternalId = await repos.transactions.findByExternalId(fields.providerId, fields.externalTransactionId);
    if (sameExternalId) {
      throw new ExternalTransactionConflictError(fields.providerId, fields.externalTransactionId, sameExternalId.id);
    }

    if (!wallet) {
      throw new UnprocessableTransactionError(FailureCode.WalletNotFound, `wallet ${fields.walletId} not found`);
    }

    const tx = WagerTransaction.create({
      ...fields,
      idempotencyKey,
      payloadHash,
      money: Money.from(fields.money),
      createdAt: now,
    });
    await settleAndPersist(repos, tx, wallet, {
      isNew: true,
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId,
      now,
    });
    return toWagerResult(tx, false, wallet.balance.toJSON());
  }

  private parse(command: SubmitWagerCommand): { fields: WagerBusinessFields; idempotencyKey: string } {
    const key = command.idempotencyKey;
    if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY_LENGTH) {
      throw new InvalidRequestError(`Idempotency-Key is required (1..${MAX_KEY_LENGTH} chars)`);
    }
    const p = command.payload;
    if (!p || typeof p !== "object") throw new InvalidRequestError("body must be a JSON object");

    const str = (name: keyof WagerTransactionPayload): string => {
      const value = p[name];
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidRequestError(`${String(name)} must be a non-empty string`);
      }
      return value;
    };
    const ref = p.referenceExternalTransactionId;
    if (ref !== undefined && ref !== null && typeof ref !== "string") {
      throw new InvalidRequestError("referenceExternalTransactionId must be a string");
    }
    if (!p.money || typeof p.money !== "object") throw new InvalidRequestError("money must be an object");

    const fields: WagerBusinessFields = {
      providerId: str("providerId"),
      externalTransactionId: str("externalTransactionId"),
      playerId: str("playerId"),
      walletId: str("walletId"),
      roundId: str("roundId"),
      gameId: str("gameId"),
      kind: str("kind"),
      money: p.money as MoneyProps,
      referenceExternalTransactionId: typeof ref === "string" && ref !== "" ? ref : undefined,
    };
    Money.from(fields.money);
    return { fields, idempotencyKey: key };
  }
}
