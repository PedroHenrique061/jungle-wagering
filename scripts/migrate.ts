import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "@/infrastructure/persistence/mikro-orm.config";

/**
 * bun run db:migrate   → aplica as pendentes
 * bun run db:rollback  → desfaz a última
 * bun run db:status    → lista executadas e pendentes
 * bun run db:reset     → desfaz todas e reaplica (prova que o down é completo)
 */
const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(createOrmConfig());
const migrator = orm.getMigrator();

try {
  switch (command) {
    case "up": {
      const applied = await migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(", ")}` : "Nothing to apply");
      break;
    }
    case "down": {
      const reverted = await migrator.down();
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(", ")}` : "Nothing to revert");
      break;
    }
    case "status": {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log("Executed:", executed.map((m) => m.name));
      console.log("Pending:", pending.map((m) => m.name));
      break;
    }
    case "reset": {
      await migrator.down({ to: 0 });
      const applied = await migrator.up();
      console.log(`Reset done. Applied: ${applied.map((m) => m.name).join(", ")}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}" (use up | down | status | reset)`);
  }
} finally {
  await orm.close(true);
}
