import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule, configureApp } from "@/app.module";
import { loadConfig, type AppConfig } from "@/config";
import { PrometheusMetrics } from "@/infrastructure/observability/prometheus-metrics";
import { JsonLogger } from "@/shared/observability/logger";
import { uuidv7 } from "@/shared/domain/uuid";

export const TEST_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  SQS_TRANSACTIONS_QUEUE_URL:
    process.env.SQS_TRANSACTIONS_QUEUE_URL ?? "http://localhost:4566/000000000000/wager-transactions.fifo",
  SQS_EVENTS_QUEUE_URL: process.env.SQS_EVENTS_QUEUE_URL ?? "http://localhost:4566/000000000000/wagering-events.fifo",
};

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  logs: string[];
  close(): Promise<void>;
}

export async function startTestApp(databaseUrl: string, overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const config = loadConfig(
    { ...process.env, ...TEST_ENV, DATABASE_URL: databaseUrl },
    {
      instanceId: `test-${uuidv7().slice(-6)}`,
      roles: { http: true, consumer: false, outboxPublisher: false, referenceWorker: false },
      ...overrides,
    },
  );
  const logs: string[] = [];
  const logger = new JsonLogger({ service: "test" }, "info", (line) => logs.push(line));
  const app = await NestFactory.create(
    AppModule.register({ config, logger, metrics: new PrometheusMetrics({ defaultMetrics: false }) }),
    { logger: false },
  );
  configureApp(app);
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    config,
    logs,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function http<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // corpo que não é JSON, como o do /metrics
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}
