import type { Money } from "@/shared/domain/money";
import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

/**
 * Portas de persistência. O domínio e os use cases dependem só destas interfaces;
 * a implementação (MikroORM/PostgreSQL) fica em infrastructure/persistence.
 *
 * Toda chamada acontece DENTRO de UnitOfWork.run — uma transação SQL.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: serializa operações na MESMA wallet; wallets diferentes seguem em paralelo. */
  lockById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE condicional `WHERE id = ? AND version = expectedVersion`.
   * @throws ConcurrencyConflictError se outra escrita mudou a wallet (defesa em profundidade ao lock).
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface TransactionInsertMeta {
  correlationId?: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** FOR UPDATE: usado pelo worker de PENDING_REFERENCE. */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  /** @throws UniqueViolationError em (provider, idempotency_key) ou (provider, external_id). */
  insert(tx: WagerTransaction, meta?: TransactionInsertMeta): Promise<void>;
  /** Persiste apenas as colunas mutáveis (status e resultado). Campos de negócio são imutáveis no schema. */
  update(tx: WagerTransaction): Promise<void>;
  /** A referência já é alvo de um REFUND/ROLLBACK PROCESSED? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /**
   * Reivindica transações PENDING_REFERENCE vencidas com FOR UPDATE SKIP LOCKED:
   * várias instâncias rodam o worker sem processar a mesma linha.
   */
  claimDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  /** Antecipa a próxima verificação das transações que esperam por (provider, externalId). */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** seq do último item da página; undefined se não há próxima página. */
  nextAfterSeq?: string;
}

export interface LedgerTotals {
  /** Σ créditos − Σ débitos, recalculado do zero. */
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  /**
   * INSERT … ON CONFLICT DO NOTHING. Retorna false se (consumer, messageId) já existe:
   * a mensagem é redelivery e deve ser descartada (ack) sem efeitos.
   */
  tryReceive(message: InboxMessage, transactionId?: string): Promise<boolean>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt?: Date;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /**
   * Reivindica até `limit` mensagens vencidas com lease (locked_by/locked_until) via SKIP LOCKED.
   * Se o publisher morrer, o lease expira e outra instância assume.
   */
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

/** Fronteira transacional: tudo dentro de `work` é commitado junto ou nada é. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Repositórios fora de transação, para consultas. */
export interface ReadRepositories {
  wallets: Pick<WalletRepository, "findById">;
  transactions: Pick<WagerTransactionRepository, "findById" | "findByExternalId">;
  ledger: Pick<LedgerRepository, "page" | "totals">;
  outbox: Pick<OutboxRepository, "stats">;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
export const READ_REPOSITORIES = Symbol("ReadRepositories");
