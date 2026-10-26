import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import { createTestDatabase, type TestDatabase } from "../support/test-database";
import { http, startTestApp, type TestApp } from "../support/test-app";

let db: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase("http_api");
  api = await startTestApp(db.url);
});

afterAll(async () => {
  await api?.close();
  await db?.close();
});

const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  http(api.baseUrl, method, path, body, headers);

async function createWallet(amount = "100.00", playerId = uuidv7()) {
  const res = await call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

function wager(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
): { body: Record<string, unknown>; key: string } {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `tx-${uuidv7()}`;
  return {
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...extra,
    },
    key: `provider-a:${externalTransactionId}`,
  };
}

const submit = (w: ReturnType<typeof wager>, key = w.key) =>
  call("POST", "/wagering/transactions", w.body, { "Idempotency-Key": key });

async function ledgerSum(walletId: string): Promise<string> {
  const rec = await call("POST", `/wallets/${walletId}/reconciliation`);
  expect(rec.body.consistent).toBe(true);
  return rec.body.calculatedBalance.amount;
}

describe("POST /wallets", () => {
  test("cria wallet com saldo inicial: OPENING + lançamento CREDIT, version 1", async () => {
    const wallet = await createWallet("1000.00");
    expect(wallet.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    const ledger = await call("GET", `/wallets/${wallet.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0].direction).toBe("CREDIT");
  });

  test("wallet duplicada (player + moeda) → 409", async () => {
    const wallet = await createWallet("0.00");
    const dup = await call("POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["amount numérico", { amount: 10, currency: "BRL" }],
    ["notação científica", { amount: "1e3", currency: "BRL" }],
    ["três casas", { amount: "1.001", currency: "BRL" }],
    ["negativo", { amount: "-1.00", currency: "BRL" }],
  ])("payload inválido (%s) → 400", async (_label, initialBalance) => {
    const res = await call("POST", "/wallets", { playerId: uuidv7(), initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error.retryable).toBe(false);
  });

  test("JSON malformado → 400", async () => {
    const res = await call("POST", "/wallets", "{not json");
    expect(res.status).toBe(400);
  });
});

describe("POST /wagering/transactions", () => {
  test("BET processada → 201 com saldo; replay idêntico → 200 com o mesmo resultado", async () => {
    const wallet = await createWallet("1000.00");
    const bet = wager(wallet, "BET", "25.00");
    const first = await submit(bet);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });

    // Saldo muda depois; o replay devolve o saldo observado NAQUELE momento.
    await submit(wager(wallet, "WIN", "100.00"));
    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await ledgerSum(wallet.id)).toBe("1075.00");
  });

  test("mesma Idempotency-Key com payload diferente → 409 (conflito, não replay)", async () => {
    const wallet = await createWallet("100.00");
    const bet = wager(wallet, "BET", "10.00");
    await submit(bet);
    const tampered = { ...bet, body: { ...bet.body, money: { amount: "11.00", currency: "BRL" } } };
    const res = await submit(tampered);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect((await call("GET", `/wallets/${wallet.id}`)).body.balance.amount).toBe("90.00");
  });

  test("mesmo externalTransactionId com outra chave → 409", async () => {
    const wallet = await createWallet("100.00");
    const bet = wager(wallet, "BET", "10.00");
    await submit(bet);
    const res = await submit(bet, "outra-chave");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
  });

  test("saldo insuficiente → 422 INSUFFICIENT_FUNDS, sem ledger", async () => {
    const wallet = await createWallet("10.00");
    const res = await submit(wager(wallet, "BET", "25.00"));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    expect((await call("GET", `/wallets/${wallet.id}/ledger`)).body.items).toHaveLength(1);
  });

  test("LOSS → 201 sem mover saldo; version inalterada", async () => {
    const wallet = await createWallet("50.00");
    const res = await submit(wager(wallet, "LOSS", "20.00"));
    expect(res.status).toBe(201);
    const after = await call("GET", `/wallets/${wallet.id}`);
    expect(after.body).toMatchObject({ balance: { amount: "50.00" }, version: 1 });
  });

  test("REFUND antes da BET → 202 PENDING_REFERENCE; BET depois não é afetada", async () => {
    const wallet = await createWallet("100.00");
    const betId = `bet-${uuidv7()}`;
    const refund = await submit(wager(wallet, "REFUND", "30.00", { referenceExternalTransactionId: betId }));
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");
    const bet = await submit(wager(wallet, "BET", "30.00", { externalTransactionId: betId }));
    expect(bet.status).toBe(201);
    expect(bet.body.balance.amount).toBe("70.00");
    // Sem o worker (Etapa 5), a REFUND continua pendente mas já foi antecipada pelo wakeDependents.
    const pending = await call("GET", `/wagering/transactions/${refund.body.transactionId}`);
    expect(pending.body.status).toBe("PENDING_REFERENCE");
  });

  test("ROLLBACK de BET → crédito; segunda reversão da mesma BET → 422 REFERENCE_ALREADY_REVERSED", async () => {
    const wallet = await createWallet("100.00");
    const betId = `bet-${uuidv7()}`;
    await submit(wager(wallet, "BET", "40.00", { externalTransactionId: betId }));
    const rollback = await submit(wager(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: betId }));
    expect(rollback.status).toBe(201);
    expect(rollback.body.balance.amount).toBe("100.00");
    const refund = await submit(wager(wallet, "REFUND", "40.00", { referenceExternalTransactionId: betId }));
    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await ledgerSum(wallet.id)).toBe("100.00");
  });

  test("wallet inexistente → 422 WALLET_NOT_FOUND", async () => {
    const res = await submit(wager({ id: uuidv7(), playerId: uuidv7() }, "BET", "1.00"));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test.each([
    ["sem Idempotency-Key", (w: ReturnType<typeof wager>) => call("POST", "/wagering/transactions", w.body)],
    ["kind OPENING", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, kind: "OPENING" } })],
    ["REFUND sem referência", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, kind: "REFUND" } })],
    ["money como number", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, money: { amount: 1, currency: "BRL" } } })],
  ])("%s → 400", async (_label, send) => {
    const wallet = await createWallet("10.00");
    const res = await send(wager(wallet, "BET", "1.00"));
    expect(res.status).toBe(400);
  });

  test("moeda diferente da wallet → 422 CURRENCY_MISMATCH", async () => {
    const wallet = await createWallet("10.00");
    const w = wager(wallet, "BET", "1.00");
    const res = await submit({ ...w, body: { ...w.body, money: { amount: "1.00", currency: "USD" } } });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("CURRENCY_MISMATCH");
  });
});

describe("consultas", () => {
  test("GET transação por id e por (provider, externalId)", async () => {
    const wallet = await createWallet("100.00");
    const bet = wager(wallet, "BET", "5.00");
    const res = await submit(bet);
    const byId = await call("GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "5.00", currency: "BRL" } });
    const byExt = await call("GET", `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`);
    expect(byExt.body.transactionId).toBe(res.body.transactionId);
  });

  test("404 para ids inexistentes ou malformados", async () => {
    expect((await call("GET", `/wallets/${uuidv7()}`)).status).toBe(404);
    expect((await call("GET", `/wallets/not-a-uuid`)).status).toBe(404);
    expect((await call("GET", `/wagering/transactions/${uuidv7()}`)).status).toBe(404);
  });

  test("ledger paginado com cursor opaco e estável", async () => {
    const wallet = await createWallet("100.00");
    for (let i = 0; i < 5; i++) await submit(wager(wallet, "BET", "1.00"));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await call("GET", `/wallets/${wallet.id}/ledger${qs}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);

    const other = await createWallet("1.00");
    const first = await call("GET", `/wallets/${wallet.id}/ledger?limit=2`);
    const foreign = await call("GET", `/wallets/${other.id}/ledger?cursor=${first.body.nextCursor}`);
    expect(foreign.status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
  });

  test("reconciliação consistente devolve o formato do contrato", async () => {
    const wallet = await createWallet("975.00");
    const res = await call("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
    });
  });
});

describe("operação", () => {
  test("health live e ready (PostgreSQL + SQS reais)", async () => {
    expect((await call("GET", "/health/live")).status).toBe(200);
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres.ok).toBe(true);
    expect(ready.body.checks.sqs.ok).toBe(true);
  });

  test("correlation id é propagado e aparece nos logs; payload financeiro não", async () => {
    const wallet = await createWallet("100.00");
    const res = await call("POST", "/wagering/transactions", wager(wallet, "BET", "33.33").body, {
      "Idempotency-Key": `k-${uuidv7()}`,
      "X-Correlation-Id": "corr-test-123",
    });
    expect(res.headers.get("x-correlation-id")).toBe("corr-test-123");
    const line = api.logs.find((l) => l.includes("corr-test-123"));
    expect(line).toBeDefined();
    const entry = JSON.parse(line!);
    expect(entry).toMatchObject({ correlationId: "corr-test-123", walletId: wallet.id, providerId: "provider-a" });
    expect(api.logs.join("\n")).not.toContain("33.33");
  });

  test("métricas expostas em formato Prometheus", async () => {
    const res = await call("GET", "/metrics");
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("wagering_transactions_total");
    expect(String(res.body)).toContain("wagering_processing_duration_seconds");
  });
});
