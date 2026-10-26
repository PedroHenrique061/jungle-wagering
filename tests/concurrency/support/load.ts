import { resolve } from "node:path";
import { expect } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import type { TestDatabase } from "../../support/test-database";
import { TEST_ENV } from "../../support/test-app";

export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

export interface WalletRef {
  id: string;
  playerId: string;
}

export async function createWallet(baseUrl: string, amount: string): Promise<WalletRef> {
  const playerId = `player-${uuidv7()}`;
  const res = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: "BRL" } }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

export function wagerBody(
  wallet: WalletRef,
  kind: string,
  amount: string,
  externalTransactionId: string = `ext-${uuidv7()}`,
  extra: Record<string, unknown> = {},
) {
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-load",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...extra,
    },
  };
}

export interface WagerResponse {
  status: number;
  body: {
    transactionId?: string;
    status?: string;
    failureCode?: string;
    balance?: { amount: string };
    idempotentReplay?: boolean;
    error?: { code: string; retryable: boolean };
  };
}

export async function postWager(baseUrl: string, w: ReturnType<typeof wagerBody>): Promise<WagerResponse> {
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": w.key },
    body: JSON.stringify(w.body),
  });
  return { status: res.status, body: (await res.json()) as WagerResponse["body"] };
}

/**
 * Cliente "provedor": reenvia com a MESMA Idempotency-Key até obter resposta definitiva,
 * girando entre instâncias quando uma cai (conexão recusada/resetada) ou responde 503.
 */
export async function postWagerWithRetry(
  baseUrls: string[],
  w: ReturnType<typeof wagerBody>,
  options: { maxAttempts?: number; start?: number } = {},
): Promise<WagerResponse & { attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 200;
  let index = options.start ?? 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const baseUrl = baseUrls[index % baseUrls.length]!;
    index++;
    try {
      const response = await postWager(baseUrl, w);
      if (response.status !== 503 && response.status !== 502) return { ...response, attempts: attempt };
    } catch {
      /* instância fora do ar: tenta a próxima */
    }
    await Bun.sleep(50);
  }
  throw new Error(`no definitive answer for ${w.key} after ${maxAttempts} attempts`);
}

export interface WalletInvariants {
  balance: string;
  ledgerBalance: string;
  version: number;
  debits: number;
  credits: number;
  statuses: Record<string, number>;
}

/** Estado final lido direto do banco: saldo materializado, saldo do ledger e contagens. */
export async function walletInvariants(db: TestDatabase, walletId: string): Promise<WalletInvariants> {
  const [w] = await db.sql<{ balance: string; version: number }>(
    `SELECT balance::text AS balance, version FROM wallets WHERE id = ?`,
    [walletId],
  );
  const [l] = await db.sql<{ ledger: string; debits: number; credits: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS ledger,
            COUNT(*) FILTER (WHERE direction = 'DEBIT')::int AS debits,
            COUNT(*) FILTER (WHERE direction = 'CREDIT')::int AS credits
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  const rows = await db.sql<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING' GROUP BY status`,
    [walletId],
  );
  return {
    balance: w!.balance,
    ledgerBalance: l!.ledger,
    version: w!.version,
    debits: l!.debits,
    credits: l!.credits,
    statuses: Object.fromEntries(rows.map((r) => [r.status, r.n])),
  };
}

/** A invariante final de TODOS os testes (seção 13). */
export function expectLedgerConsistent(inv: WalletInvariants): void {
  expect(inv.ledgerBalance).toBe(inv.balance);
  // version = 1 (abertura) + 1 por mudança de saldo (cada lançamento após a abertura).
  expect(inv.version).toBe(inv.debits + inv.credits);
}

// ---------------------------------------------------------------- instâncias em processos separados

export interface SpawnedInstance {
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
}

export function instanceEnv(port: number, overrides: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...TEST_ENV,
    PORT: String(port),
    INSTANCE_ID: `proc-${port}`,
    LOG_LEVEL: "error",
    DB_POOL_MAX: "8",
    SQS_WAIT_TIME_SECONDS: "1",
    ...overrides,
  };
}

/** Sobe `bun run src/main.ts` — a aplicação real, em outro processo do sistema operacional. */
export async function spawnInstance(port: number, env: Record<string, string>): Promise<SpawnedInstance> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/main.ts"],
    cwd: PROJECT_ROOT,
    env: instanceEnv(port, env),
    stdout: "ignore",
    stderr: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(baseUrl, proc);
  return { port, baseUrl, proc };
}

export async function waitReady(baseUrl: string, proc?: ReturnType<typeof Bun.spawn>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
      throw new Error(`instance at ${baseUrl} exited with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      /* ainda subindo */
    }
    await Bun.sleep(150);
  }
  throw new Error(`instance at ${baseUrl} not ready after ${timeoutMs}ms`);
}

export async function stopInstance(instance: SpawnedInstance, signal: "SIGTERM" | "SIGKILL"): Promise<number> {
  instance.proc.kill(signal);
  return instance.proc.exited;
}

/** Espera uma condição assíncrona (com prazo). */
export async function eventually(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`condition not met in ${timeoutMs}ms: ${label}`);
}

export function randomPort(): number {
  return 41_000 + Math.floor(Math.random() * 8_000);
}
