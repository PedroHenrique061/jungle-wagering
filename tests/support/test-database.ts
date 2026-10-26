import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "@/infrastructure/persistence/mikro-orm.config";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDatabase {
  orm: MikroORM;
  url: string;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const database = `wagering_test_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  const admin = await MikroORM.init({ ...createOrmConfig(withDatabase(BASE_URL, "postgres")), pool: { min: 0, max: 1 } });
  try {
    const conn = admin.em.getConnection();
    await conn.execute(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await conn.execute(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.close(true);
  }

  const url = withDatabase(BASE_URL, database);
  const orm = await MikroORM.init(createOrmConfig(url));
  await orm.getMigrator().up();

  return {
    orm,
    url,
    sql: <T>(query: string, params: unknown[] = []) =>
      orm.em.fork().getConnection().execute(query, params as never[]) as Promise<T[]>,
    close: () => orm.close(true),
  };
}

export async function expectDbError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let i = 0; i < 4 && current; i++) {
      if (current instanceof Error) parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected the database to reject the operation, but it succeeded");
}
