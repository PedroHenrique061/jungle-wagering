import { hostname } from "node:os";
import { uuidv7 } from "@/shared/domain/uuid";

export interface AppConfig {
  port: number;
  instanceId: string;
  databaseUrl: string;
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    transactionsQueueUrl: string;
    /** DLQ da fila de entrada: destino explícito de mensagens com erro permanente. */
    dlqUrl: string;
    eventsQueueUrl: string;
    /** Deve ser igual ao maxReceiveCount da redrive policy (infra/localstack/init-sqs.sh). */
    maxReceiveCount: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
  };
  /** Papéis desta instância. Por padrão todas fazem tudo; em produção podem ser separados. */
  roles: {
    http: boolean;
    consumer: boolean;
    outboxPublisher: boolean;
    referenceWorker: boolean;
  };
}

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };

  return {
    port: Number(env.PORT ?? 3000),
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${uuidv7().slice(-6)}`,
    databaseUrl: overrides.databaseUrl ?? required("DATABASE_URL"),
    aws: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.SQS_ENDPOINT || undefined,
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    sqs: {
      transactionsQueueUrl: required("SQS_TRANSACTIONS_QUEUE_URL"),
      dlqUrl:
        env.SQS_TRANSACTIONS_DLQ_URL ??
        required("SQS_TRANSACTIONS_QUEUE_URL").replace(/\.fifo$/, "-dlq.fifo"),
      eventsQueueUrl: required("SQS_EVENTS_QUEUE_URL"),
      maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
      waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 10),
      visibilityTimeoutSeconds: Number(env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
    },
    roles: {
      http: true,
      consumer: flag(env.ROLE_CONSUMER, true),
      outboxPublisher: flag(env.ROLE_OUTBOX_PUBLISHER, true),
      referenceWorker: flag(env.ROLE_REFERENCE_WORKER, true),
    },
    ...overrides,
  };
}

export const APP_CONFIG = Symbol("AppConfig");
