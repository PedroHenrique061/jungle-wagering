import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration20261026000001_initial_schema } from "./migrations/Migration20261026000001_initial_schema";
import { Migration20261026000002_integrity_triggers } from "./migrations/Migration20261026000002_integrity_triggers";
import { ALL_SCHEMAS } from "./records";

export const MIGRATIONS = [
  { name: "Migration20261026000001_initial_schema", class: Migration20261026000001_initial_schema },
  { name: "Migration20261026000002_integrity_triggers", class: Migration20261026000002_integrity_triggers },
];

export function createOrmConfig(databaseUrl: string = process.env.DATABASE_URL ?? "") {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    forceUtcTimezone: true,
    allowGlobalContext: false,
    debug: process.env.DB_DEBUG === "true",
    pool: { min: 1, max: Number(process.env.DB_POOL_MAX ?? 10) },
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList: MIGRATIONS,
    },
  });
}
