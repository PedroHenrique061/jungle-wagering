import { Money } from "@/shared/domain/money";
import type { FailureCode } from "@/wagering/domain/failure-code";
import { InboxMessage } from "@/wagering/domain/inbox-message";
import { OutboxMessage } from "@/wagering/domain/outbox-message";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "@/wagering/domain/wager-transaction";
import { Wallet } from "@/wagering/domain/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "@/wagering/domain/wallet-ledger-entry";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/** Postgres pode devolver NUMERIC sem zeros à direita dependendo do driver; Money normaliza. */
const money = (amount: string, currency: string) => Money.fromPersistence(String(amount), currency.trim());
const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

// ---------------------------------------------------------------- Wallet

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency.trim(),
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  const s = w.toState();
  return {
    id: s.id,
    playerId: s.playerId,
    currency: s.currency,
    balance: s.balance.amount,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---------------------------------------------------------------- WagerTransaction

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: opt(r.referenceTransactionId),
    failureCode: opt(r.failureCode) as FailureCode | undefined,
    processedAt: opt(r.processedAt),
    resultBalance: r.resultBalance == null ? undefined : money(r.resultBalance, r.currency),
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: opt(r.nextReferenceCheckAt),
  });
}

/** Colunas mutáveis — as únicas que `update` grava (o trigger rejeita mudança nas demais). */
export function transactionMutableColumns(t: WagerTransaction, now: Date): Partial<WagerTransactionRecord> {
  const s = t.toState();
  return {
    status: s.status,
    referenceTransactionId: s.referenceTransactionId ?? null,
    failureCode: s.failureCode ?? null,
    resultBalance: s.resultBalance?.amount ?? null,
    processedAt: s.processedAt ?? null,
    referenceAttempts: s.referenceAttempts,
    nextReferenceCheckAt: s.nextReferenceCheckAt ?? null,
    updatedAt: now,
  };
}

export function transactionToRecord(t: WagerTransaction, correlationId: string | undefined, now: Date): WagerTransactionRecord {
  const s = t.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    idempotencyKey: s.idempotencyKey,
    payloadHash: s.payloadHash,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId,
    gameId: s.gameId,
    kind: s.kind,
    amount: s.money.amount,
    currency: s.money.currency,
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    correlationId: correlationId ?? null,
    createdAt: s.createdAt,
    ...(transactionMutableColumns(t, now) as Required<Pick<WagerTransactionRecord, "status" | "referenceAttempts" | "updatedAt">>),
  };
}

// ---------------------------------------------------------------- Ledger

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): Omit<LedgerEntryRecord, "seq"> {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.amount,
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.amount,
    balanceAfter: e.balanceAfter.amount,
    createdAt: e.createdAt,
  };
}

// ---------------------------------------------------------------- Inbox / Outbox

export function inboxToRecord(m: InboxMessage, transactionId?: string): InboxMessageRecord {
  const s = m.toState();
  return {
    consumerName: s.consumerName,
    messageId: s.messageId,
    payloadHash: s.payloadHash,
    receivedAt: s.receivedAt,
    processedAt: s.processedAt ?? null,
    transactionId: transactionId ?? null,
  };
}

export function outboxFromRecord(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: opt(r.publishedAt),
  });
}

export function outboxToRecord(m: OutboxMessage): OutboxMessageRecord {
  const s = m.toState();
  return {
    id: s.id,
    aggregateId: s.aggregateId,
    eventType: s.eventType,
    // Cópia profunda: o domínio entrega o payload congelado e o ORM normaliza parâmetros no lugar.
    payload: JSON.parse(JSON.stringify(s.payload)) as Record<string, unknown>,
    occurredAt: s.occurredAt,
    attempts: s.attempts,
    // Coluna NOT NULL: sem agendamento, vence imediatamente.
    nextAttemptAt: s.nextAttemptAt ?? s.occurredAt,
    publishedAt: s.publishedAt ?? null,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
  };
}
