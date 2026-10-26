import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uuidv7 } from "@/shared/domain/uuid";
import { JsonLogger } from "@/shared/observability/logger";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/mikro-orm-unit-of-work";
import { CreateWallet } from "@/wagering/application/create-wallet";
import type { Repositories, UnitOfWork } from "@/wagering/application/ports";
import { SubmitWagerTransaction } from "@/wagering/application/submit-wager-transaction";
import { createTestDatabase, type TestDatabase } from "../support/test-database";
import { RecordingMetrics } from "../support/recording-metrics";

let db: TestDatabase;
let uow: MikroOrmUnitOfWork;
const logger = new JsonLogger({ service: "test" }, "error");

beforeAll(async () => {
  db = await createTestDatabase("atomicity");
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await db?.close();
});

class CrashBeforeCommit extends Error {}

class CrashingUnitOfWork implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repos) => {
      await work(repos);
      throw new CrashBeforeCommit("process died after writing everything and before COMMIT");
    });
  }
}

async function snapshot(walletId: string, externalTransactionId: string, messageId: string) {
  const [row] = await db.sql<{
    balance: string;
    version: number;
    ledger: number;
    transactions: number;
    inbox: number;
    outbox: number;
  }>(
    `SELECT (SELECT balance::text FROM wallets WHERE id = ?) AS balance,
            (SELECT version FROM wallets WHERE id = ?) AS version,
            (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
            (SELECT COUNT(*)::int FROM wager_transactions WHERE external_transaction_id = ?) AS transactions,
            (SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = ?) AS inbox,
            (SELECT COUNT(*)::int FROM outbox_messages WHERE payload->'data'->>'walletId' = ?) AS outbox`,
    [walletId, walletId, walletId, externalTransactionId, messageId, walletId],
  );
  return row!;
}

describe("atomicidade entre wallet, ledger, inbox e outbox", () => {
  test("falha depois de gravar tudo e antes do COMMIT não deixa nenhum rastro", async () => {
    const playerId = `player-${uuidv7()}`;
    const wallet = await new CreateWallet(uow, logger).execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
      correlationId: "t",
    });
    const externalTransactionId = `ext-${uuidv7()}`;
    const messageId = `msg-${uuidv7()}`;
    const before = await snapshot(wallet.id, externalTransactionId, messageId);

    const command = {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      source: "sqs" as const,
      correlationId: "t",
      inbox: { consumerName: "wager-transactions-consumer", messageId },
      payload: {
        providerId: "provider-a",
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "30.00", currency: "BRL" },
      },
    };

    const crashing = new SubmitWagerTransaction(new CrashingUnitOfWork(uow), new RecordingMetrics(), logger);
    await expect(crashing.execute(command)).rejects.toBeInstanceOf(CrashBeforeCommit);

    expect(await snapshot(wallet.id, externalTransactionId, messageId)).toEqual(before);
    expect(before).toMatchObject({ balance: "100.00", version: 1, ledger: 1, transactions: 0, inbox: 0 });

    const healthy = new SubmitWagerTransaction(uow, new RecordingMetrics(), logger);
    const result = await healthy.execute(command);
    expect(result).toMatchObject({ status: "PROCESSED", idempotentReplay: false });

    const after = await snapshot(wallet.id, externalTransactionId, messageId);
    expect(after).toMatchObject({ balance: "70.00", version: 2, ledger: 2, transactions: 1, inbox: 1 });
    expect(after.outbox).toBe(before.outbox + 2);
  });

  test("criação de wallet que falha antes do COMMIT não deixa wallet, OPENING, lançamento nem evento", async () => {
    const playerId = `player-${uuidv7()}`;
    const crashing = new CreateWallet(new CrashingUnitOfWork(uow), logger);
    await expect(
      crashing.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" }, correlationId: "t" }),
    ).rejects.toBeInstanceOf(CrashBeforeCommit);

    const [row] = await db.sql<{ wallets: number; ledger: number; transactions: number }>(
      `SELECT (SELECT COUNT(*)::int FROM wallets WHERE player_id = ?) AS wallets,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE w.player_id = ?) AS ledger,
              (SELECT COUNT(*)::int FROM wager_transactions WHERE player_id = ?) AS transactions`,
      [playerId, playerId, playerId],
    );
    expect(row).toEqual({ wallets: 0, ledger: 0, transactions: 0 });

    const created = await new CreateWallet(uow, logger).execute({
      playerId,
      initialBalance: { amount: "50.00", currency: "BRL" },
      correlationId: "t",
    });
    expect(created).toMatchObject({ playerId, balance: { amount: "50.00" }, version: 1 });
  });
});
