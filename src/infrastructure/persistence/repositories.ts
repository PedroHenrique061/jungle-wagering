import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "@/shared/domain/money";
import { ConcurrencyConflictError } from "@/wagering/application/errors";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  OutboxStats,
  Repositories,
  TransactionInsertMeta,
  WagerTransactionRepository,
  WalletRepository,
} from "@/wagering/application/ports";
import type { InboxMessage } from "@/wagering/domain/inbox-message";
import type { OutboxMessage } from "@/wagering/domain/outbox-message";
import type { WagerTransaction } from "@/wagering/domain/wager-transaction";
import type { Wallet } from "@/wagering/domain/wallet";
import type { WalletLedgerEntry } from "@/wagering/domain/wallet-ledger-entry";
import {
  inboxToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  outboxFromRecord,
  outboxToRecord,
  transactionFromRecord,
  transactionMutableColumns,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "./mappers";
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id }, FRESH);
    return record ? walletFromRecord(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletFromRecord(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletToRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new ConcurrencyConflictError("wallet", wallet.id);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return record ? transactionFromRecord(record) : undefined;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }, FRESH);
    return record ? transactionFromRecord(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, FRESH);
    return record ? transactionFromRecord(record) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? transactionFromRecord(record) : undefined;
  }

  async insert(tx: WagerTransaction, meta?: TransactionInsertMeta): Promise<void> {
    await this.em.insert(WagerTransactionRecord, transactionToRecord(tx, meta?.correlationId, new Date()));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      transactionMutableColumns(tx, new Date()),
    );
    if (affected !== 1) throw new ConcurrencyConflictError("wager_transaction", tx.id);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?
        ORDER BY next_reference_check_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    // SKIP LOCKED: se o worker já pegou a dependente, ele mesmo reavalia
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE wager_transactions SET next_reference_check_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE provider_id = ? AND reference_external_transaction_id = ?
             AND status = 'PENDING_REFERENCE' AND next_reference_check_at > ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [now, now, providerId, externalTransactionId, now],
    );
    return rows.length;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerEntryToRecord(entry));
  }

  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    if (!isUuid(walletId)) return { entries: [] };
    const where = afterSeq === undefined ? { walletId } : { walletId, seq: { $gt: afterSeq } };
    const records = await this.em.find(LedgerEntryRecord, where, {
      ...FRESH,
      orderBy: { seq: "asc" },
      limit: limit + 1,
    });
    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    return {
      entries: pageRecords.map(ledgerEntryFromRecord),
      nextAfterSeq: hasMore ? String(pageRecords[pageRecords.length - 1]!.seq) : undefined,
    };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ calculated: string; entries: number }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20, 2)::text AS calculated,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      calculatedBalance: Money.fromPersistence(row?.calculated ?? "0.00", currency),
      entries: Number(row?.entries ?? 0),
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage, transactionId?: string): Promise<boolean> {
    const r = inboxToRecord(message, transactionId);
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at, transaction_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [r.consumerName, r.messageId, r.payloadHash, r.receivedAt, r.processedAt ?? null, r.transactionId ?? null],
    );
    return rows.length === 1;
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(outboxToRecord));
  }

  async claimDue(now: Date, limit: number, workerId: string, leaseMs: number): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.em.execute<OutboxRow[]>(
      `UPDATE outbox_messages o
          SET locked_by = ?, locked_until = ?
        WHERE o.id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY next_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at,
                  o.attempts, o.next_attempt_at, o.published_at`,
      [workerId, leaseUntil, now, now, limit],
    );
    return rows
      .map((r) =>
        outboxFromRecord({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: typeof r.payload === "string" ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
          occurredAt: new Date(r.occurred_at),
          attempts: r.attempts,
          nextAttemptAt: new Date(r.next_attempt_at),
          publishedAt: r.published_at ? new Date(r.published_at) : null,
        }),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage, _workerId: string): Promise<void> {
    await this.em.execute(
      // sem filtrar por locked_by: se dois publishers enviaram, o primeiro a marcar vence e o consumidor deduplica pelo eventId
      `UPDATE outbox_messages SET published_at = ?, locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = ? AND published_at IS NULL`,
      [message.publishedAt ?? new Date(), message.id],
      "run",
    );
  }

  async scheduleRetry(message: OutboxMessage, workerId: string, error: string): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
        WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error.slice(0, 512), message.id, workerId],
      "run",
    );
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<{ pending: number; oldest: Date | null }[]>(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingOccurredAt: row?.oldest ? new Date(row.oldest) : undefined,
    };
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
