import type { Money } from "@/shared/domain/money";
import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface TransactionInsertMeta {
  correlationId?: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  insert(tx: WagerTransaction, meta?: TransactionInsertMeta): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  claimDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextAfterSeq?: string;
}

export interface LedgerTotals {
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  tryReceive(message: InboxMessage, transactionId?: string): Promise<boolean>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt?: Date;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDue(now: Date, limit: number, workerId: string, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage, workerId: string): Promise<void>;
  scheduleRetry(message: OutboxMessage, workerId: string, error: string): Promise<void>;
  stats(): Promise<OutboxStats>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface ReadRepositories {
  wallets: Pick<WalletRepository, "findById">;
  transactions: Pick<WagerTransactionRepository, "findById" | "findByExternalId">;
  ledger: Pick<LedgerRepository, "page" | "totals">;
  outbox: Pick<OutboxRepository, "stats">;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
export const READ_REPOSITORIES = Symbol("ReadRepositories");
