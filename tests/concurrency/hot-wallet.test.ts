import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import { createTestDatabase, type TestDatabase } from "../support/test-database";
import { startTestApp, type TestApp } from "../support/test-app";
import {
  createWallet,
  expectLedgerConsistent,
  postWager,
  wagerBody,
  walletInvariants,
  type WagerResponse,
} from "./support/load";

let db: TestDatabase;
let apps: TestApp[] = [];
let urls: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase("concurrency_hot_wallet");
  apps = await Promise.all([1, 2, 3].map(() => startTestApp(db.url)));
  urls = apps.map((a) => a.baseUrl);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db?.close();
});

const spread = <T>(n: number, fn: (i: number, url: string) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => fn(i, urls[i % urls.length]!)));

describe("seção 13 - concorrência", () => {
  test("1. a mesma aposta enviada 50 vezes em paralelo -> um único débito", async () => {
    const wallet = await createWallet(urls[0]!, "1000.00");
    const bet = wagerBody(wallet, "BET", "25.00");

    const responses = await spread(50, (_i, url) => postWager(url, bet));

    const created = responses.filter((r) => r.status === 201);
    const replays = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(replays.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.balance?.amount))).toEqual(new Set(["975.00"]));

    const inv = await walletInvariants(db, wallet.id);
    expect(inv).toMatchObject({ balance: "975.00", debits: 1, statuses: { PROCESSED: 1 } });
    expectLedgerConsistent(inv);
  });

  test("2. cenário obrigatório: saldo 100.00, duas apostas de 80.00 simultâneas (25 rodadas)", async () => {
    for (let round = 0; round < 25; round++) {
      const wallet = await createWallet(urls[0]!, "100.00");
      const a = wagerBody(wallet, "BET", "80.00");
      const b = wagerBody(wallet, "BET", "80.00");

      const [ra, rb] = await Promise.all([postWager(urls[round % 3]!, a), postWager(urls[(round + 1) % 3]!, b)]);
      const outcomes = [ra, rb].map((r) => `${r.status}:${r.body.status}:${r.body.failureCode ?? ""}`).sort();
      expect(outcomes).toEqual(["201:PROCESSED:", "422:REJECTED:INSUFFICIENT_FUNDS"]);

      const [again1, again2] = await Promise.all([postWager(urls[2]!, a), postWager(urls[1]!, b)]);
      expect(again1.body.transactionId).toBe(ra.body.transactionId);
      expect(again2.body.transactionId).toBe(rb.body.transactionId);
      expect(again1.body.status).toBe(ra.body.status!);
      expect(again2.body.status).toBe(rb.body.status!);

      const inv = await walletInvariants(db, wallet.id);
      expect(inv).toMatchObject({ balance: "20.00", debits: 1, statuses: { PROCESSED: 1, REJECTED: 1 } });
      expectLedgerConsistent(inv);
    }
  });

  test("hot wallet: 200 apostas de 1.00 simultâneas sobre 100.00 -> exatamente 100 aceitas, saldo nunca negativo", async () => {
    const wallet = await createWallet(urls[0]!, "100.00");
    const responses = await spread(200, (_i, url) => postWager(url, wagerBody(wallet, "BET", "1.00")));

    const byStatus = countBy(responses, (r) => r.status);
    expect(byStatus).toEqual({ 201: 100, 422: 100 });
    expect(responses.filter((r) => r.status === 422).every((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toBe(true);

    const inv = await walletInvariants(db, wallet.id);
    expect(inv).toMatchObject({ balance: "0.00", debits: 100, statuses: { PROCESSED: 100, REJECTED: 100 } });
    expectLedgerConsistent(inv);
  });

  test("3. wallets distintas em paralelo: 25 wallets x 8 apostas simultâneas", async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => createWallet(urls[0]!, "100.00")));
    const jobs = wallets.flatMap((w) => Array.from({ length: 8 }, () => wagerBody(w, "BET", "2.50")));
    const responses = await Promise.all(jobs.map((job, i) => postWager(urls[i % 3]!, job)));
    expect(responses.every((r) => r.status === 201)).toBe(true);

    for (const w of wallets) {
      const inv = await walletInvariants(db, w.id);
      expect(inv).toMatchObject({ balance: "80.00", debits: 8 });
      expectLedgerConsistent(inv);
    }
  });

  test("REFUND e ROLLBACK simultâneos da mesma BET -> exatamente uma reversão (20 rodadas)", async () => {
    for (let round = 0; round < 20; round++) {
      const wallet = await createWallet(urls[0]!, "100.00");
      const betId = `bet-${uuidv7()}`;
      expect((await postWager(urls[0]!, wagerBody(wallet, "BET", "30.00", betId))).status).toBe(201);

      const [refund, rollback] = await Promise.all([
        postWager(urls[1]!, wagerBody(wallet, "REFUND", "30.00", undefined, { referenceExternalTransactionId: betId })),
        postWager(urls[2]!, wagerBody(wallet, "ROLLBACK", "30.00", undefined, { referenceExternalTransactionId: betId })),
      ]);
      const outcomes = [refund, rollback].map((r) => `${r.status}:${r.body.failureCode ?? ""}`).sort();
      expect(outcomes).toEqual(["201:", "422:REFERENCE_ALREADY_REVERSED"]);

      const inv = await walletInvariants(db, wallet.id);
      expect(inv).toMatchObject({ balance: "100.00", debits: 1, credits: 2 });
      expectLedgerConsistent(inv);
    }
  });

  test("BET, WIN e ROLLBACK do WIN disputando a mesma wallet com saldo justo", async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await createWallet(urls[0]!, "50.00");
      const winId = `win-${uuidv7()}`;
      expect((await postWager(urls[0]!, wagerBody(wallet, "WIN", "100.00", winId))).status).toBe(201);

      const responses = await Promise.all([
        postWager(urls[0]!, wagerBody(wallet, "ROLLBACK", "100.00", undefined, { referenceExternalTransactionId: winId })),
        ...Array.from({ length: 6 }, (_, i) => postWager(urls[(i + 1) % 3]!, wagerBody(wallet, "BET", "20.00"))),
      ]);
      const rollback = responses[0]!;
      expect([201, 422]).toContain(rollback.status);
      if (rollback.status === 422) expect(rollback.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");

      const inv = await walletInvariants(db, wallet.id);
      expect(Number(inv.balance)).toBeGreaterThanOrEqual(0);
      expectLedgerConsistent(inv);
    }
  });
});

function countBy<T>(items: T[], key: (item: T) => number | string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[String(key(item))] = (out[String(key(item))] ?? 0) + 1;
  return out;
}

export type { WagerResponse };
