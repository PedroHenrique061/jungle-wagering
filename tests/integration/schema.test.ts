import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "@/shared/domain/money";
import { uuidv7 } from "@/shared/domain/uuid";
import { UniqueViolationError } from "@/wagering/application/errors";
import { InboxMessage } from "@/wagering/domain/inbox-message";
import { OutboxMessage } from "@/wagering/domain/outbox-message";
import { WagerTransaction, WagerTransactionKind } from "@/wagering/domain/wager-transaction";
import { Wallet } from "@/wagering/domain/wallet";
import { WagerTransactionProcessed } from "@/wagering/domain/events/wagering-events";
import { createOrmConfig } from "@/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/mikro-orm-unit-of-work";
import { computeWagerPayloadHash } from "@/wagering/domain/wager-payload-hash";
import { createTestDatabase, expectDbError, type TestDatabase } from "../support/test-database";

let db: TestDatabase;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase("schema");
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await db?.close();
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

/** Abre uma wallet do jeito certo: wallet + OPENING + lançamento na mesma transação. */
async function seedWallet(amount = "100.00", playerId = uuidv7()) {
  const now = new Date();
  const openingId = uuidv7();
  const { wallet, openingEntry } = Wallet.open({
    playerId,
    initialBalance: brl(amount),
    openingTransactionId: openingId,
    now,
  });
  const opening = openingEntry
    ? WagerTransaction.opening({ id: openingId, walletId: wallet.id, playerId, money: brl(amount), at: now })
    : undefined;
  await uow.run(async (r) => {
    await r.wallets.insert(wallet);
    if (opening && openingEntry) {
      await r.transactions.insert(opening);
      await r.ledger.append(openingEntry);
    }
  });
  return { wallet, opening: opening!, playerId };
}

function betFor(wallet: Wallet, playerId: string, externalTransactionId = uuidv7(), key?: string) {
  const fields = {
    providerId: "provider-a",
    externalTransactionId,
    playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "10.00", currency: "BRL" },
  };
  return WagerTransaction.create({
    ...fields,
    idempotencyKey: key ?? `provider-a:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(fields),
    money: brl("10.00"),
    createdAt: new Date(),
  });
}

describe("migrations", () => {
  test("são reversíveis: down até zero remove tudo e up recria", async () => {
    const other = await createTestDatabase("migrations_roundtrip");
    try {
      const migrator = other.orm.getMigrator();
      await migrator.down({ to: 0 });
      const after = await other.sql<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
      );
      expect(after[0]!.n).toBe(0);
      const functions = await other.sql<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname IN
           ('ledger_append_only','ledger_chain_check','wallet_ledger_consistency_check','wallet_guard','wager_tx_guard','outbox_guard')`,
      );
      expect(functions[0]!.n).toBe(0);
      await migrator.up();
      expect(await migrator.getPendingMigrations()).toHaveLength(0);
    } finally {
      await other.close();
    }
  });
});

describe("wallets", () => {
  test("round trip preserva Money e version", async () => {
    const { wallet } = await seedWallet("1234.56");
    const loaded = await uow.run((r) => r.wallets.findById(wallet.id));
    expect(loaded?.balance.toJSON()).toEqual({ amount: "1234.56", currency: "BRL" });
    expect(loaded?.version).toBe(1);
  });

  test("UNIQUE (player_id, currency): segunda wallet BRL do mesmo player falha; USD é permitida", async () => {
    const { playerId } = await seedWallet("0.00");
    const dup = Wallet.open({ playerId, initialBalance: brl("0"), now: new Date() }).wallet;
    const error = await uow.run((r) => r.wallets.insert(dup)).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe("wallets_player_currency_uq");

    const usd = Wallet.open({ playerId, initialBalance: Money.from({ amount: "0", currency: "USD" }), now: new Date() }).wallet;
    await uow.run((r) => r.wallets.insert(usd));
  });

  test("CHECK balance >= 0", async () => {
    const { wallet } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(`UPDATE wallets SET balance = -1, version = version + 1 WHERE id = ?`, [wallet.id]),
    );
    expect(msg).toContain("wallets_balance_non_negative");
  });

  test("saldo sem lançamento correspondente é rejeitado no COMMIT", async () => {
    const { wallet } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(`UPDATE wallets SET balance = 999, version = version + 1 WHERE id = ?`, [wallet.id]),
    );
    expect(msg).toContain("does not match ledger");
  });

  test("wallet criada com saldo e sem ledger é rejeitada no COMMIT", async () => {
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 50, 1, now(), now())`,
        [uuidv7(), uuidv7()],
      ),
    );
    expect(msg).toContain("does not match ledger");
  });

  test("version só muda junto com o saldo, e de 1 em 1", async () => {
    const { wallet } = await seedWallet("10.00");
    expect(await expectDbError(() => db.sql(`UPDATE wallets SET version = version + 1 WHERE id = ?`, [wallet.id]))).toContain(
      "must not change",
    );
  });

  test("UPDATE condicional por versão detecta escrita concorrente", async () => {
    const { wallet, opening } = await seedWallet("100.00");
    const stale = Wallet.rehydrate(wallet.toState());
    const entry = stale.debit({ transactionId: opening.id, money: brl("1.00"), at: new Date() });
    void entry;
    const error = await uow.run((r) => r.wallets.saveBalance(stale, 999)).catch((e) => e);
    expect((error as Error).name).toBe("ConcurrencyConflictError");
  });

  test("DELETE é proibido", async () => {
    const { wallet } = await seedWallet("0.00");
    expect(await expectDbError(() => db.sql(`DELETE FROM wallets WHERE id = ?`, [wallet.id]))).toContain("cannot be deleted");
  });
});

describe("wallet_ledger_entries", () => {
  test("UPDATE, DELETE e TRUNCATE são proibidos (append-only)", async () => {
    const { wallet } = await seedWallet("10.00");
    expect(await expectDbError(() => db.sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [wallet.id]))).toContain(
      "append-only",
    );
    expect(await expectDbError(() => db.sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]))).toContain(
      "append-only",
    );
    expect(await expectDbError(() => db.sql(`TRUNCATE wallet_ledger_entries CASCADE`))).toContain("append-only");
  });

  test("aritmética before ± amount = after é CHECK do banco", async () => {
    const { wallet, opening } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 5, 'BRL', 10, 6, now())`,
        [uuidv7(), wallet.id, opening.id],
      ),
    );
    expect(msg).toContain("ledger_arithmetic_balanced");
  });

  test("encadeamento: balance_before precisa ser o balance_after anterior", async () => {
    const { wallet, opening } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 5, 'BRL', 50, 55, now())`,
        [uuidv7(), wallet.id, opening.id],
      ),
    );
    expect(msg).toContain("ledger chain broken");
  });

  test("no máximo um lançamento por transação por wallet", async () => {
    const { wallet, opening } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 5, 'BRL', 10, 15, now())`,
        [uuidv7(), wallet.id, opening.id],
      ),
    );
    expect(msg).toContain("ledger_one_entry_per_tx_wallet_uq");
  });

  test("totals reconstrói o saldo a partir do ledger", async () => {
    const { wallet } = await seedWallet("75.25");
    const totals = await uow.run((r) => r.ledger.totals(wallet.id, "BRL"));
    expect(totals.calculatedBalance.amount).toBe("75.25");
    expect(totals.entries).toBe(1);
  });
});

describe("wager_transactions", () => {
  test("UNIQUE (provider_id, idempotency_key) e (provider_id, external_transaction_id)", async () => {
    const { wallet, playerId } = await seedWallet("100.00");
    const first = betFor(wallet, playerId, "ext-dup-1");
    await uow.run((r) => r.transactions.insert(first));

    const sameKey = betFor(wallet, playerId, "ext-dup-2", first.idempotencyKey);
    const e1 = await uow.run((r) => r.transactions.insert(sameKey)).catch((e) => e);
    expect((e1 as UniqueViolationError).constraint).toBe("wager_tx_provider_idempotency_uq");

    const sameExternal = betFor(wallet, playerId, "ext-dup-1", "another-key");
    const e2 = await uow.run((r) => r.transactions.insert(sameExternal)).catch((e) => e);
    expect((e2 as UniqueViolationError).constraint).toBe("wager_tx_provider_external_uq");
  });

  test("transação terminal não muda mais de estado", async () => {
    const { opening } = await seedWallet("10.00");
    expect(
      await expectDbError(() => db.sql(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [opening.id])),
    ).toContain("is terminal");
  });

  test("campos de negócio são imutáveis mesmo em PENDING", async () => {
    const { wallet, playerId } = await seedWallet("100.00");
    const bet = betFor(wallet, playerId);
    await uow.run((r) => r.transactions.insert(bet));
    expect(await expectDbError(() => db.sql(`UPDATE wager_transactions SET amount = 1 WHERE id = ?`, [bet.id]))).toContain(
      "immutable",
    );
  });

  test("REFUND/ROLLBACK sem referência é rejeitado pelo schema", async () => {
    const { wallet, playerId } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
         VALUES (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'REFUND', 10, 'BRL', 'PENDING', now(), now())`,
        [uuidv7(), uuidv7(), uuidv7(), wallet.id, playerId],
      ),
    );
    expect(msg).toContain("wager_tx_reversal_needs_reference");
  });

  test("uma transação só pode ser revertida uma vez (índice único parcial)", async () => {
    const { wallet, playerId, opening } = await seedWallet("100.00");
    const insertReversal = (kind: "REFUND" | "ROLLBACK") =>
      db.sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
           status, result_balance, processed_at, created_at, updated_at)
         VALUES (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', ?, 100, 'BRL', 'ref', ?, 'PROCESSED', 100, now(), now(), now())`,
        [uuidv7(), uuidv7(), uuidv7(), wallet.id, playerId, kind, opening.id],
      );
    await insertReversal("REFUND");
    expect(await expectDbError(() => insertReversal("ROLLBACK"))).toContain("wager_tx_single_reversal_uq");
  });

  test("failure_code existe se e somente se REJECTED/FAILED", async () => {
    const { wallet, playerId } = await seedWallet("10.00");
    const msg = await expectDbError(() =>
      db.sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, processed_at, created_at, updated_at)
         VALUES (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 10, 'BRL', 'REJECTED', now(), now(), now())`,
        [uuidv7(), uuidv7(), uuidv7(), wallet.id, playerId],
      ),
    );
    expect(msg).toContain("wager_tx_failure_code_iff_failed");
  });

  test("DELETE é proibido", async () => {
    const { opening } = await seedWallet("10.00");
    expect(await expectDbError(() => db.sql(`DELETE FROM wager_transactions WHERE id = ?`, [opening.id]))).toContain(
      "cannot be deleted",
    );
  });
});

describe("inbox", () => {
  test("(consumer, messageId) deduplica: segunda recepção retorna false", async () => {
    const message = () =>
      InboxMessage.receive({ messageId: "msg-dup", consumerName: "wager-consumer", payloadHash: "h", receivedAt: new Date() });
    expect(await uow.run((r) => r.inbox.tryReceive(message()))).toBe(true);
    expect(await uow.run((r) => r.inbox.tryReceive(message()))).toBe(false);
  });

  test("recepções concorrentes da mesma mensagem: exatamente uma vence", async () => {
    const id = `msg-${uuidv7()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        uow.run((r) =>
          r.inbox.tryReceive(InboxMessage.receive({ messageId: id, consumerName: "c", payloadHash: "h", receivedAt: new Date() })),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("outbox", () => {
  async function enqueue(n: number) {
    const { wallet, opening } = await seedWallet("1.00");
    const messages = Array.from({ length: n }, () =>
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(opening, { correlationId: wallet.id, occurredAt: new Date(Date.now() - 1000) }),
      ),
    );
    await uow.run((r) => r.outbox.enqueue(messages));
    return messages;
  }

  test("dois publishers concorrentes nunca reivindicam a mesma mensagem (SKIP LOCKED)", async () => {
    const enqueued = await enqueue(20);
    const ids = new Set(enqueued.map((m) => m.id));
    const [a, b] = await Promise.all([
      uow.run((r) => r.outbox.claimDue(new Date(), 50, "worker-a", 30_000)),
      uow.run((r) => r.outbox.claimDue(new Date(), 50, "worker-b", 30_000)),
    ]);
    const claimedA = a.filter((m) => ids.has(m.id)).map((m) => m.id);
    const claimedB = b.filter((m) => ids.has(m.id)).map((m) => m.id);
    expect(claimedA.filter((id) => claimedB.includes(id))).toHaveLength(0);
    expect(new Set([...claimedA, ...claimedB]).size).toBe(20);
  });

  test("lease expirado (publisher morreu) permite que outra instância assuma", async () => {
    const [msg] = await enqueue(1);
    const claimed = await uow.run((r) => r.outbox.claimDue(new Date(), 1000, "dead-worker", 1));
    expect(claimed.some((m) => m.id === msg!.id)).toBe(true);
    await Bun.sleep(20);
    const reclaimed = await uow.run((r) => r.outbox.claimDue(new Date(), 1000, "survivor", 30_000));
    expect(reclaimed.some((m) => m.id === msg!.id)).toBe(true);

    const published = reclaimed.find((m) => m.id === msg!.id)!;
    published.markPublished(new Date());
    await uow.run((r) => r.outbox.markPublished(published, "survivor"));
    const again = await uow.run((r) => r.outbox.claimDue(new Date(Date.now() + 60_000), 1000, "x", 1));
    expect(again.some((m) => m.id === msg!.id)).toBe(false);
  });

  test("publicação não pode ser desfeita e o envelope é imutável", async () => {
    const [msg] = await enqueue(1);
    await db.sql(`UPDATE outbox_messages SET published_at = now() WHERE id = ?`, [msg!.id]);
    expect(await expectDbError(() => db.sql(`UPDATE outbox_messages SET published_at = NULL WHERE id = ?`, [msg!.id]))).toContain(
      "already published",
    );
    expect(
      await expectDbError(() => db.sql(`UPDATE outbox_messages SET event_type = 'X' WHERE id = ?`, [msg!.id])),
    ).toContain("immutable");
  });
});

describe("conexão de teste", () => {
  test("usa um banco isolado por arquivo", async () => {
    const [row] = await db.sql<{ db: string }>(`SELECT current_database() AS db`);
    expect(row!.db).toBe("wagering_test_schema");
    expect(createOrmConfig).toBeDefined();
    expect(MikroORM).toBeDefined();
  });
});
