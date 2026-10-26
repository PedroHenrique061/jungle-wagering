import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import { createTestDatabase, type TestDatabase } from "../support/test-database";
import { createTestQueues, type TestQueues } from "../support/test-queues";
import {
  createWallet,
  eventually,
  expectLedgerConsistent,
  postWager,
  postWagerWithRetry,
  randomPort,
  spawnInstance,
  stopInstance,
  wagerBody,
  walletInvariants,
  type SpawnedInstance,
} from "./support/load";

let db: TestDatabase;
let queues: TestQueues;
let instances: SpawnedInstance[] = [];
let env: Record<string, string>;

beforeAll(async () => {
  db = await createTestDatabase("concurrency_multi_instance");
  queues = await createTestQueues("mi", { maxReceiveCount: 5, visibilityTimeoutSeconds: 5 });
  env = {
    DATABASE_URL: db.url,
    SQS_TRANSACTIONS_QUEUE_URL: queues.queueUrl,
    SQS_TRANSACTIONS_DLQ_URL: queues.dlqUrl,
    SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
    SQS_MAX_RECEIVE_COUNT: "5",
    SQS_VISIBILITY_TIMEOUT_SECONDS: "5",
  };
  const base = randomPort();
  instances = await Promise.all([0, 1, 2].map((i) => spawnInstance(base + i, env)));
}, 90_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => stopInstance(i, "SIGKILL").catch(() => 0)));
  await queues?.destroy();
  await db?.close();
});

const urls = () => instances.map((i) => i.baseUrl);

async function pendingWork(walletId: string) {
  const [row] = await db.sql<{ pending: number; outbox: number }>(
    `SELECT (SELECT COUNT(*)::int FROM wager_transactions WHERE wallet_id = ? AND status IN ('PENDING','PENDING_REFERENCE')) AS pending,
            (SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NULL) AS outbox`,
    [walletId],
  );
  return row!;
}

describe("seção 13 - múltiplos processos", () => {
  test("4. três processos disputam a mesma wallet por HTTP e pela fila, com duplicatas e referências fora de ordem", async () => {
    const wallet = await createWallet(urls()[0]!, "1000.00");

    const lateBets = Array.from({ length: 10 }, () => `late-bet-${uuidv7()}`);
    const refunds = await Promise.all(
      lateBets.map((betId, i) =>
        postWager(urls()[i % 3]!, wagerBody(wallet, "REFUND", "5.00", undefined, { referenceExternalTransactionId: betId })),
      ),
    );
    expect(refunds.every((r) => r.status === 202)).toBe(true);

    const httpBets = Array.from({ length: 150 }, () => wagerBody(wallet, "BET", "1.00"));
    const httpResponses = await Promise.all(httpBets.flatMap((bet) => urls().map((url) => postWager(url, bet))));

    const sqsBets = Array.from({ length: 30 }, () => wagerBody(wallet, "BET", "1.00"));
    const lateBetBodies = lateBets.map((betId) => wagerBody(wallet, "BET", "5.00", betId));
    for (const bet of [...sqsBets, ...lateBetBodies]) {
      const message = {
        messageId: `msg-${uuidv7()}`,
        type: "WagerTransactionRequested",
        data: { ...bet.body, idempotencyKey: bet.key },
      };
      await queues.send(message, wallet.id);
      await queues.send(message, wallet.id);
    }

    await eventually(async () => (await queues.count(queues.queueUrl)) === 0, 60_000, "transactions queue drained");
    await eventually(
      async () => {
        const w = await pendingWork(wallet.id);
        return w.pending === 0 && w.outbox === 0;
      },
      60_000,
      "pending references processed and outbox published",
    );

    for (let i = 0; i < httpBets.length; i++) {
      const trio = httpResponses.slice(i * 3, i * 3 + 3);
      expect(trio.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(trio.map((r) => r.body.transactionId)).size).toBe(1);
    }

    const inv = await walletInvariants(db, wallet.id);
    expect(inv).toMatchObject({
      balance: "820.00",
      debits: 150 + 30 + 10,
      credits: 1 + 10,
      statuses: { PROCESSED: 150 + 30 + 10 + 10 },
    });
    expectLedgerConsistent(inv);
    expect(await queues.count(queues.dlqUrl)).toBe(0);
  }, 120_000);

  test("8. reinício: SIGKILL numa instância e SIGTERM em outra no meio da carga -> consistência final", async () => {
    const wallet = await createWallet(urls()[0]!, "500.00");
    const bets = Array.from({ length: 200 }, () => wagerBody(wallet, "BET", "1.00"));

    let completed = 0;
    const load = Promise.all(
      bets.map(async (bet, i) => {
        await Bun.sleep(Math.floor(i / 10) * 40);
        const response = await postWagerWithRetry(urls(), bet, { start: i });
        completed++;
        return response;
      }),
    );

    await eventually(async () => completed >= 50, 30_000, "first 50 requests answered");
    const [killed, terminated] = [instances[1]!, instances[2]!];
    await Promise.all([stopInstance(killed, "SIGKILL"), stopInstance(terminated, "SIGTERM")]);

    instances[1] = await spawnInstance(killed.port, env);
    instances[2] = await spawnInstance(terminated.port, env);

    const responses = await load;
    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(responses.some((r) => r.attempts > 1)).toBe(true);

    const rows = await db.sql<{ id: string; external_transaction_id: string }>(
      `SELECT id, external_transaction_id FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [wallet.id],
    );
    expect(rows).toHaveLength(200);
    const byExternal = new Map(rows.map((r) => [r.external_transaction_id, r.id]));
    bets.forEach((bet, i) => expect(responses[i]!.body.transactionId).toBe(byExternal.get(bet.body.externalTransactionId)!));

    const inv = await walletInvariants(db, wallet.id);
    expect(inv).toMatchObject({ balance: "300.00", debits: 200, statuses: { PROCESSED: 200 } });
    expectLedgerConsistent(inv);

    const rec = await fetch(`${urls()[1]}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(((await rec.json()) as { consistent: boolean }).consistent).toBe(true);
  }, 120_000);
});
