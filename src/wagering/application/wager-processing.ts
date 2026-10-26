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
import type { BackoffPolicy } from "../domain/retry-policy";
import { WagerSettlement, type SettlementOutcome } from "../domain/wager-settlement";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { Repositories } from "./ports";

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  idempotentReplay: boolean;
}

export interface SettleOptions {
  isNew: boolean;
  correlationId?: string;
  causationId?: string;
  now: Date;
  policy?: BackoffPolicy;
}

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
    policy: options.policy,
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
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, options.now);
      break;
    case "REJECTED":
      events.push(WagerTransactionRejected.from(tx, ctx));
      break;
    case "PENDING_REFERENCE":
      // só na entrada em espera; as reavaliações do worker não geram um evento por tentativa
      if (options.isNew) events.push(WagerTransactionPendingReference.from(tx, ctx));
      break;
  }

  await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
  return outcome;
}

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
