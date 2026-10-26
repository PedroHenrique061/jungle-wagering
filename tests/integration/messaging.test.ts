import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import { JsonLogger } from "@/shared/observability/logger";
import { PollingLoop, sleep } from "@/shared/runtime/polling-loop";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/mikro-orm-unit-of-work";
import { SqsEventPublisher } from "@/infrastructure/sqs/sqs-event-publisher";
import { WagerTransactionConsumer, type WagerSubmitter } from "@/interfaces/sqs/wager-transaction-consumer";
import { CreateWallet } from "@/wagering/application/create-wallet";
import { TransientInfrastructureError } from "@/wagering/application/errors";
import { OutboxRelay, type IntegrationEventPublisher } from "@/wagering/application/outbox-relay";
import { ProcessPendingReferences } from "@/wagering/application/process-pending-references";
import { SubmitWagerTransaction } from "@/wagering/application/submit-wager-transaction";
import { WagerTransactionStatus } from "@/wagering/domain/wager-transaction";
import { createTestDatabase, type TestDatabase } from "../support/test-database";
import { createTestQueues, type TestQueues } from "../support/test-queues";
import { RecordingMetrics } from "../support/recording-metrics";

let db: TestDatabase;
let queues: TestQueues;
let uow: MikroOrmUnitOfWork;
const logger = new JsonLogger({ service: "test" }, "error");

beforeAll(async () => {
  db = await createTestDatabase("messaging");
  queues = await createTestQueues("msg", { maxReceiveCount: 2, visibilityTimeoutSeconds: 1 });
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await queues?.destroy();
  await db?.close();
});

// ---------------------------------------------------------------- helpers

async function newWallet(amount = "100.00") {
  const playerId = `player-${uuidv7()}`;
  const view = await new CreateWallet(uow, logger).execute({
    playerId,
    initialBalance: { amount, currency: "BRL" },
    correlationId: "test",
  });
  return { walletId: view.id, playerId };
}

function envelope(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `ext-${uuidv7()}`;
  return {
    messageId: `msg-${uuidv7()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...extra,
    },
  };
}

function consumer(metrics = new RecordingMetrics(), submitter?: WagerSubmitter, extra: Partial<ConstructorParameters<typeof WagerTransactionConsumer>[4]> = {}) {
  const submit = submitter ?? new SubmitWagerTransaction(uow, metrics, logger);
  return new WagerTransactionConsumer(queues.sqs, submit, metrics, logger, {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    maxReceiveCount: queues.maxReceiveCount,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 1,
    maxBackoffSeconds: 1,
    ...extra,
  });
}

/** Faz polls até a fila principal esvaziar (ou estourar o prazo). */
async function pollUntilEmpty(c: WagerTransactionConsumer, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await c.pollOnce();
    if ((await queues.count(queues.queueUrl)) === 0) return;
  }
  throw new Error("queue did not drain in time");
}

async function balanceOf(walletId: string) {
  const [row] = await db.sql<{ balance: string; ledger: string; entries: number }>(
    `SELECT w.balance::text AS balance,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS ledger,
            COUNT(l.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.balance`,
    [walletId],
  );
  return row!;
}

async function txByExternal(externalTransactionId: string) {
  const [row] = await db.sql<{ id: string; status: string; failure_code: string | null }>(
    `SELECT id, status, failure_code FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
    [externalTransactionId],
  );
  return row;
}

// ---------------------------------------------------------------- consumidor

describe("consumidor SQS", () => {
  test("mensagem válida → mesmo use case do HTTP, PROCESSED e ack depois do commit", async () => {
    const w = await newWallet("100.00");
    const msg = envelope(w, "BET", "25.00");
    await queues.send(msg, w.walletId);
    await pollUntilEmpty(consumer());
    expect((await txByExternal(msg.data.externalTransactionId))?.status).toBe("PROCESSED");
    const b = await balanceOf(w.walletId);
    expect(b.balance).toBe("75.00");
    expect(b.ledger).toBe(b.balance);
  });

  test("mesma mensagem publicada 2x pelo produtor → inbox deduplica, um único débito", async () => {
    const w = await newWallet("100.00");
    const msg = envelope(w, "BET", "10.00");
    await queues.send(msg, w.walletId);
    await queues.send(msg, w.walletId);
    const metrics = new RecordingMetrics();
    await pollUntilEmpty(consumer(metrics));
    const b = await balanceOf(w.walletId);
    expect(b.balance).toBe("90.00");
    expect(b.entries).toBe(2); // abertura + 1 débito
    expect(metrics.duplicates).toContain("inbox_redelivery");
  });

  test("worker morre DEPOIS do commit e ANTES do ack → redelivery sem efeito duplicado", async () => {
    const w = await newWallet("100.00");
    const msg = envelope(w, "BET", "30.00");
    await queues.send(msg, w.walletId);

    let crashed = false;
    const dying = consumer(new RecordingMetrics(), undefined, {
      crashBeforeAck: () => {
        if (crashed) return false;
        crashed = true;
        return true;
      },
    });
    while (!crashed) await dying.pollOnce();
    expect((await balanceOf(w.walletId)).balance).toBe("70.00"); // commit aconteceu
    expect(await queues.count(queues.queueUrl)).toBe(1); // mas a mensagem não foi removida

    const metrics = new RecordingMetrics();
    await pollUntilEmpty(consumer(metrics)); // outra "instância" recebe a redelivery
    const b = await balanceOf(w.walletId);
    expect(b.balance).toBe("70.00");
    expect(b.entries).toBe(2);
    expect(metrics.duplicates).toContain("inbox_redelivery");
  });

  test("erro de negócio (wallet inexistente) → ack, não vai para a DLQ", async () => {
    const before = await queues.count(queues.dlqUrl);
    const msg = envelope({ walletId: uuidv7(), playerId: "ghost" }, "BET", "1.00");
    await queues.send(msg, "ghost-group");
    await pollUntilEmpty(consumer());
    expect(await queues.count(queues.dlqUrl)).toBe(before);
    expect(await txByExternal(msg.data.externalTransactionId)).toBeUndefined();
  });

  test("rejeição de regra (saldo insuficiente) é resultado, não erro: PROCESSA como REJECTED e faz ack", async () => {
    const w = await newWallet("5.00");
    const msg = envelope(w, "BET", "50.00");
    await queues.send(msg, w.walletId);
    await pollUntilEmpty(consumer());
    const tx = await txByExternal(msg.data.externalTransactionId);
    expect(tx).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
  });

  test("mensagem malformada → DLQ imediata, com o motivo", async () => {
    await queues.drain(queues.dlqUrl, 1);
    await queues.send("{isto não é json", "poison");
    const metrics = new RecordingMetrics();
    await pollUntilEmpty(consumer(metrics));
    const dead = await queues.drain(queues.dlqUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe("MALFORMED_MESSAGE");
    expect(metrics.dlq).toContain("MALFORMED_MESSAGE");
  });

  test("erro transitório → retry com backoff e DLQ (redrive) depois de maxReceiveCount", async () => {
    await queues.drain(queues.dlqUrl, 1);
    const w = await newWallet("100.00");
    await queues.send(envelope(w, "BET", "1.00"), w.walletId);
    const metrics = new RecordingMetrics();
    const failing: WagerSubmitter = {
      execute: () => Promise.reject(new TransientInfrastructureError("database unavailable")),
    };
    const c = consumer(metrics, failing);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await queues.count(queues.queueUrl)) > 0) await c.pollOnce();

    expect(await queues.count(queues.queueUrl)).toBe(0);
    expect((await queues.drain(queues.dlqUrl)).length).toBe(1);
    expect(metrics.retries.some((r) => r.operation === "sqs_consume")).toBe(true);
    expect(metrics.dlq).toContain("retries_exhausted");
    expect((await balanceOf(w.walletId)).balance).toBe("100.00");
  });

  test("SIGTERM: a mensagem em andamento termina; as não iniciadas voltam para a fila", async () => {
    const w = await newWallet("100.00");
    const first = envelope(w, "BET", "1.00");
    const second = envelope(w, "BET", "2.00");
    await queues.send(first, w.walletId);
    await queues.send(second, w.walletId);

    const real = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    let started = 0;
    const slow: WagerSubmitter = {
      async execute(command) {
        started++;
        await sleep(400);
        return real.execute(command);
      },
    };
    const c = consumer(new RecordingMetrics(), slow);
    const loop = new PollingLoop({ name: "test-consumer", tick: async (s) => (await c.pollOnce(s)) > 0, idleMs: 50, logger });
    loop.start();
    while (started === 0) await sleep(20);
    await loop.stop(); // "SIGTERM" no meio do processamento

    expect(started).toBe(1);
    expect((await txByExternal(first.data.externalTransactionId))?.status).toBe("PROCESSED");
    expect(await txByExternal(second.data.externalTransactionId)).toBeUndefined();
    // A segunda continua na fila (devolvida ou nunca recebida) e é processada depois.
    await pollUntilEmpty(consumer());
    expect((await txByExternal(second.data.externalTransactionId))?.status).toBe("PROCESSED");
    expect((await balanceOf(w.walletId)).balance).toBe("97.00");
  });
});

// ---------------------------------------------------------------- outbox

describe("outbox publisher", () => {
  async function pendingOutbox() {
    const [row] = await db.sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    return row!.n;
  }

  test("dois publishers concorrentes: todo evento é publicado, nenhum se perde", async () => {
    await queues.drain(queues.eventsUrl, 1);
    const submit = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    for (let i = 0; i < 6; i++) {
      const w = await newWallet("50.00");
      for (let j = 0; j < 3; j++) {
        const e = envelope(w, "BET", "1.00");
        await submit.execute({ idempotencyKey: e.data.idempotencyKey, payload: e.data, source: "http", correlationId: "t" });
      }
    }
    const expected = await db.sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE published_at IS NULL`);
    expect(expected.length).toBeGreaterThanOrEqual(6 * (1 + 3 * 2));

    const publisher = new SqsEventPublisher(queues.sqs, queues.eventsUrl);
    const relays = ["a", "b"].map(
      (id) => new OutboxRelay(uow, publisher, new RecordingMetrics(), logger, { workerId: `relay-${id}`, batchSize: 7 }),
    );
    await Promise.all(
      relays.map(async (relay) => {
        while ((await relay.relayOnce()) > 0) {
          /* drena */
        }
      }),
    );
    expect(await pendingOutbox()).toBe(0);

    const received = await queues.drain(queues.eventsUrl, 15);
    const receivedIds = new Set(received.map((m) => JSON.parse(m.Body!).eventId));
    for (const { id } of expected) expect(receivedIds.has(id)).toBe(true);
    const sample = JSON.parse(received[0]!.Body!);
    expect(sample).toHaveProperty("eventType");
    expect(sample).toHaveProperty("version", 1);
  });

  test("publisher morreu com o lote reivindicado → lease expira e outra instância publica", async () => {
    const w = await newWallet("10.00"); // gera WalletBalanceChanged na outbox
    await uow.run((r) => r.outbox.claimDue(new Date(), 1000, "dead-publisher", 50));
    await sleep(100);
    const relay = new OutboxRelay(uow, new SqsEventPublisher(queues.sqs, queues.eventsUrl), new RecordingMetrics(), logger, {
      workerId: "survivor",
    });
    while ((await relay.relayOnce()) > 0) {
      /* drena */
    }
    const [row] = await db.sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`,
      [w.walletId],
    );
    expect(row!.n).toBe(0);
  });

  test("falha de publicação → reagenda com backoff, sem perder o evento", async () => {
    const w = await newWallet("10.00");
    const failing: IntegrationEventPublisher = {
      publish: async (messages) => messages.map((m) => ({ id: m.id, ok: false, error: "sqs down" })),
    };
    const metrics = new RecordingMetrics();
    const relay = new OutboxRelay(uow, failing, metrics, logger, { workerId: "flaky" });
    expect(await relay.relayOnce()).toBeGreaterThan(0);
    const [row] = await db.sql<{ attempts: number; due: boolean; published: boolean }>(
      `SELECT attempts, next_attempt_at > now() AS due, published_at IS NOT NULL AS published
         FROM outbox_messages WHERE aggregate_id = ?`,
      [w.walletId],
    );
    expect(row).toMatchObject({ attempts: 1, due: true, published: false });
    expect(metrics.retries.some((r) => r.operation === "outbox_publish")).toBe(true);
  });
});

// ---------------------------------------------------------------- referências fora de ordem

describe("worker de PENDING_REFERENCE", () => {
  const later = () => new Date(Date.now() + 10 * 60_000);

  test("ROLLBACK chega antes da BET → fica pendente → worker aplica quando a BET chega", async () => {
    const w = await newWallet("100.00");
    const submit = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    const betId = `bet-${uuidv7()}`;
    const rollback = envelope(w, "ROLLBACK", "40.00", { referenceExternalTransactionId: betId });
    const bet = envelope(w, "BET", "40.00", { externalTransactionId: betId });

    const pending = await submit.execute({ idempotencyKey: rollback.data.idempotencyKey, payload: rollback.data, source: "sqs", correlationId: "t" });
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await submit.execute({ idempotencyKey: bet.data.idempotencyKey, payload: bet.data, source: "sqs", correlationId: "t" });
    expect((await balanceOf(w.walletId)).balance).toBe("60.00");

    const worker = new ProcessPendingReferences(uow, new RecordingMetrics(), logger, { clock: later });
    await worker.processBatch(50);
    expect((await txByExternal(rollback.data.externalTransactionId))?.status).toBe("PROCESSED");
    const b = await balanceOf(w.walletId);
    expect(b.balance).toBe("100.00");
    expect(b.ledger).toBe("100.00");
  });

  test("referência nunca chega → REJECTED/REFERENCE_NOT_FOUND e evento Rejected na outbox", async () => {
    const w = await newWallet("100.00");
    const submit = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    const refund = envelope(w, "REFUND", "10.00", { referenceExternalTransactionId: `nunca-${uuidv7()}` });
    await submit.execute({ idempotencyKey: refund.data.idempotencyKey, payload: refund.data, source: "http", correlationId: "t" });

    const worker = new ProcessPendingReferences(uow, new RecordingMetrics(), logger, {
      clock: later,
      policy: { baseMs: 1, maxDelayMs: 1, maxAttempts: 3 },
    });
    for (let i = 0; i < 5; i++) await worker.processBatch(50);

    const tx = await txByExternal(refund.data.externalTransactionId);
    expect(tx).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    const events = await db.sql<{ event_type: string }>(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`, [tx!.id]);
    expect(events.map((e) => e.event_type).sort()).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect((await balanceOf(w.walletId)).balance).toBe("100.00");
  });

  test("três workers em paralelo nunca reprocessam a mesma transação", async () => {
    const w = await newWallet("1000.00");
    const submit = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    const bets: string[] = [];
    for (let i = 0; i < 12; i++) {
      const betId = `bet-${uuidv7()}`;
      bets.push(betId);
      const refund = envelope(w, "REFUND", "5.00", { referenceExternalTransactionId: betId });
      await submit.execute({ idempotencyKey: refund.data.idempotencyKey, payload: refund.data, source: "http", correlationId: "t" });
    }
    for (const betId of bets) {
      const bet = envelope(w, "BET", "5.00", { externalTransactionId: betId });
      await submit.execute({ idempotencyKey: bet.data.idempotencyKey, payload: bet.data, source: "http", correlationId: "t" });
    }
    expect((await balanceOf(w.walletId)).balance).toBe("940.00");

    const workers = [1, 2, 3].map(() => new ProcessPendingReferences(uow, new RecordingMetrics(), logger, { clock: later }));
    const counts = await Promise.all(workers.map((wk) => wk.processBatch(100)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12);

    const b = await balanceOf(w.walletId);
    expect(b.balance).toBe("1000.00");
    expect(b.ledger).toBe("1000.00");
    expect(b.entries).toBe(1 + 12 + 12);
  });
});
