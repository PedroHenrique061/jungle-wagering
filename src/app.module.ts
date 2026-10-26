import {
  type DynamicModule,
  type INestApplication,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG, type AppConfig } from "./config";
import { PrometheusMetrics } from "./infrastructure/observability/prometheus-metrics";
import { createOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmReadRepositories, MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { ORM } from "./infrastructure/persistence/tokens";
import { SQS_CLIENT, createSqsClient } from "./infrastructure/sqs/sqs-client";
import { SqsEventPublisher } from "./infrastructure/sqs/sqs-event-publisher";
import { WagerTransactionConsumer } from "./interfaces/sqs/wager-transaction-consumer";
import { WorkersLifecycle } from "./interfaces/workers/workers.lifecycle";
import { OutboxRelay } from "./wagering/application/outbox-relay";
import { ProcessPendingReferences } from "./wagering/application/process-pending-references";
import { OperationsController, WageringController, WalletsController } from "./interfaces/http/controllers";
import { HttpErrorFilter } from "./interfaces/http/http-error.filter";
import { ProviderAuthGuard } from "./interfaces/http/provider-auth.guard";
import { correlationIdMiddleware } from "./interfaces/http/request-context";
import { JsonLogger, LOGGER, type Logger } from "./shared/observability/logger";
import { CreateWallet } from "./wagering/application/create-wallet";
import { WAGERING_METRICS, type WageringMetrics } from "./wagering/application/metrics";
import { READ_REPOSITORIES, UNIT_OF_WORK, type ReadRepositories, type UnitOfWork } from "./wagering/application/ports";
import { SubmitWagerTransaction } from "./wagering/application/submit-wager-transaction";
import { WalletQueries } from "./wagering/application/wallet-queries";

@Injectable()
class ResourceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info("shutting down", { signal });
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

export interface AppModuleOptions {
  config: AppConfig;
  logger?: Logger;
  metrics?: PrometheusMetrics;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const logger = options.logger ?? new JsonLogger({ service: "jungle-wagering", instanceId: config.instanceId });
    const metrics = options.metrics ?? new PrometheusMetrics({ instanceId: config.instanceId });

    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: PrometheusMetrics, useValue: metrics },
        { provide: WAGERING_METRICS, useValue: metrics },
        { provide: ORM, useFactory: () => MikroORM.init(createOrmConfig(config.databaseUrl)) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        { provide: UNIT_OF_WORK, useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm), inject: [ORM] },
        { provide: READ_REPOSITORIES, useFactory: (orm: MikroORM) => new MikroOrmReadRepositories(orm), inject: [ORM] },
        {
          provide: SubmitWagerTransaction,
          useFactory: (uow: UnitOfWork, m: WageringMetrics, l: Logger) => new SubmitWagerTransaction(uow, m, l),
          inject: [UNIT_OF_WORK, WAGERING_METRICS, LOGGER],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, l: Logger) => new CreateWallet(uow, l),
          inject: [UNIT_OF_WORK, LOGGER],
        },
        {
          provide: WalletQueries,
          useFactory: (read: ReadRepositories, uow: UnitOfWork, m: WageringMetrics, l: Logger) =>
            new WalletQueries(read, uow, m, l),
          inject: [READ_REPOSITORIES, UNIT_OF_WORK, WAGERING_METRICS, LOGGER],
        },
        {
          provide: WagerTransactionConsumer,
          useFactory: (sqs: SQSClient, submit: SubmitWagerTransaction, m: WageringMetrics, l: Logger) =>
            new WagerTransactionConsumer(sqs, submit, m, l, {
              queueUrl: config.sqs.transactionsQueueUrl,
              dlqUrl: config.sqs.dlqUrl,
              maxReceiveCount: config.sqs.maxReceiveCount,
              waitTimeSeconds: config.sqs.waitTimeSeconds,
              visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
            }),
          inject: [SQS_CLIENT, SubmitWagerTransaction, WAGERING_METRICS, LOGGER],
        },
        {
          provide: ProcessPendingReferences,
          useFactory: (uow: UnitOfWork, m: WageringMetrics, l: Logger) => new ProcessPendingReferences(uow, m, l),
          inject: [UNIT_OF_WORK, WAGERING_METRICS, LOGGER],
        },
        {
          provide: OutboxRelay,
          useFactory: (uow: UnitOfWork, sqs: SQSClient, m: WageringMetrics, l: Logger) =>
            new OutboxRelay(uow, new SqsEventPublisher(sqs, config.sqs.eventsQueueUrl), m, l, {
              workerId: config.instanceId,
            }),
          inject: [UNIT_OF_WORK, SQS_CLIENT, WAGERING_METRICS, LOGGER],
        },
        WorkersLifecycle,
        ResourceLifecycle,
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
      exports: [SubmitWagerTransaction, UNIT_OF_WORK, READ_REPOSITORIES, WAGERING_METRICS, LOGGER, SQS_CLIENT, APP_CONFIG],
    };
  }
}

export function configureApp(app: INestApplication): INestApplication {
  app.use(correlationIdMiddleware);
  app.enableShutdownHooks();
  return app;
}
