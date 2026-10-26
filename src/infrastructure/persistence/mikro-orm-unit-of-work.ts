import type { MikroORM } from "@mikro-orm/postgresql";
import type { ReadRepositories, Repositories, UnitOfWork } from "@/wagering/application/ports";
import { translateDbError } from "./db-errors";
import { createRepositories } from "./repositories";

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

const DEFAULTS: UnitOfWorkOptions = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 };

export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly options: UnitOfWorkOptions;

  constructor(
    private readonly orm: MikroORM,
    options: Partial<UnitOfWorkOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // evita que uma wallet muito disputada segure conexões indefinidamente
        await em.execute(`SET LOCAL lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
        await em.execute(`SET LOCAL statement_timeout = '${Math.trunc(this.options.statementTimeoutMs)}ms'`);
        return work(createRepositories(em));
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }
}

export class MikroOrmReadRepositories implements ReadRepositories {
  constructor(private readonly orm: MikroORM) {}

  private repos(): Repositories {
    return createRepositories(this.orm.em.fork());
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateDbError(error);
    }
  }

  readonly wallets: ReadRepositories["wallets"] = {
    findById: (id) => this.guard(() => this.repos().wallets.findById(id)),
  };

  readonly transactions: ReadRepositories["transactions"] = {
    findById: (id) => this.guard(() => this.repos().transactions.findById(id)),
    findByExternalId: (p, e) => this.guard(() => this.repos().transactions.findByExternalId(p, e)),
  };

  readonly ledger: ReadRepositories["ledger"] = {
    page: (w, a, l) => this.guard(() => this.repos().ledger.page(w, a, l)),
    totals: (w, c) => this.guard(() => this.repos().ledger.totals(w, c)),
  };

  readonly outbox: ReadRepositories["outbox"] = {
    stats: () => this.guard(() => this.repos().outbox.stats()),
  };
}
