import { EntitySchema } from "@mikro-orm/core";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string" },
    currency: { type: "string" },
    balance: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    version: { type: "integer" },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  processedAt?: Date | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  correlationId?: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "string" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    currency: { type: "string" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    resultBalance: { type: "decimal", precision: 20, scale: 2, runtimeType: "string", nullable: true },
    processedAt: { type: "Date", nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceCheckAt: { type: "Date", nullable: true },
    correlationId: { type: "string", nullable: true },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
  },
});

export class LedgerEntryRecord {
  id!: string;
  seq!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    seq: { type: "bigint", persist: false },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    currency: { type: "string" },
    balanceBefore: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    balanceAfter: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    createdAt: { type: "Date" },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
  transactionId?: string | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "Date" },
    processedAt: { type: "Date", nullable: true },
    transactionId: { type: "uuid", nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: "Date" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "Date" },
    publishedAt: { type: "Date", nullable: true },
    lockedBy: { type: "string", nullable: true },
    lockedUntil: { type: "Date", nullable: true },
    lastError: { type: "string", nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
