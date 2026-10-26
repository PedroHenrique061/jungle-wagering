import type { MoneyProps } from "@/shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import type { IntegrationEvent, EventContext } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wagering-events";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerSettlement, type SettlementOutcome } from "../domain/wager-settlement";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { Repositories } from "./ports";

/** Resposta de submissão — igual para HTTP e fila, e reproduzida em replays. */
export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  idempotentReplay: boolean;
}

export interface SettleOptions {
  /** true: transação nova (INSERT); false: reprocessamento de PENDING_REFERENCE (UPDATE). */
  isNew: boolean;
  correlationId?: string;
  causationId?: string;
  now: Date;
}

/**
 * Passo atômico central, executado DENTRO de uma UnitOfWork com a wallet já travada:
 * resolve a referência → liquida no domínio → persiste transação, saldo, ledger e outbox.
 *
 * Ordem de escrita importa pouco (FKs deferidas), mas segue a ordem lógica para leitura.
 * Os eventos só vão para a outbox: a publicação acontece depois do COMMIT, pelo publisher.
 */
export async function settleAndPersist(
  repos: Repositories,
  tx: WagerTransaction,
  wallet: Wallet,
  options: SettleOptions,
): Promise<SettlementOutcome> {
  let reference: WagerTransaction | undefined;
  let referenceAlreadyReversed = false;
  if (tx.referenceExternalTransactionId) {
    reference = await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    if (reference && tx.isReversal()) {
      referenceAlreadyReversed = await repos.transactions.hasProcessedReversal(reference.id);
    }
  }

  const expectedVersion = wallet.version;
  const outcome = WagerSettlement.settle({
    transaction: tx,
    wallet,
    reference,
    referenceAlreadyReversed,
    now: options.now,
  });

  if (options.isNew) await repos.transactions.insert(tx, { correlationId: options.correlationId });
  else await repos.transactions.update(tx);

  const ctx: EventContext = {
    correlationId: options.correlationId ?? tx.id,
    causationId: options.causationId,
    occurredAt: options.now,
  };
  const events: IntegrationEvent<unknown>[] = [];

  switch (outcome.type) {
    case "PROCESSED":
      if (outcome.ledgerEntry) {
        await repos.wallets.saveBalance(wallet, expectedVersion);
        await repos.ledger.append(outcome.ledgerEntry);
        events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx));
      }
      events.push(WagerTransactionProcessed.from(tx, ctx));
      // Quem esperava por esta transação é reavaliado já, sem aguardar o backoff.
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, options.now);
      break;
    case "REJECTED":
      events.push(WagerTransactionRejected.from(tx, ctx));
      break;
    case "PENDING_REFERENCE":
      events.push(WagerTransactionPendingReference.from(tx, ctx));
      break;
  }

  await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
  return outcome;
}

/**
 * Resultado a partir do estado persistido. Para estados terminais usa o saldo observado
 * no momento da decisão (`resultBalance`), nunca o saldo atual — requisito de replay.
 */
export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean, currentBalance?: MoneyProps): WagerResult {
  const result: WagerResult = {
    transactionId: tx.id,
    status: tx.status,
    idempotentReplay,
  };
  const balance = tx.resultBalance?.toJSON() ?? (tx.isTerminal() ? undefined : currentBalance);
  if (balance) result.balance = balance;
  if (tx.failureCode) result.failureCode = tx.failureCode;
  if (tx.referenceTransactionId) result.referenceTransactionId = tx.referenceTransactionId;
  return result;
}
