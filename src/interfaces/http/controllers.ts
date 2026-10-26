import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG, type AppConfig } from "@/config";
import { PrometheusMetrics } from "@/infrastructure/observability/prometheus-metrics";
import { ORM } from "@/infrastructure/persistence/tokens";
import { SQS_CLIENT, checkSqs } from "@/infrastructure/sqs/sqs-client";
import { CreateWallet } from "@/wagering/application/create-wallet";
import { SubmitWagerTransaction, type WagerTransactionPayload } from "@/wagering/application/submit-wager-transaction";
import { WalletQueries } from "@/wagering/application/wallet-queries";
import type { WagerResult } from "@/wagering/application/wager-processing";
import { WagerTransactionStatus } from "@/wagering/domain/wager-transaction";
import { CorrelationId, Public } from "./request-context";

// ---------------------------------------------------------------- wallets

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: Record<string, unknown> | undefined, @CorrelationId() correlationId: string) {
    return this.createWallet.execute({
      playerId: body?.playerId,
      initialBalance: body?.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.queries.getLedger(walletId, cursor || undefined, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @CorrelationId() correlationId: string) {
    return this.queries.reconcile(walletId, correlationId);
  }
}

// ---------------------------------------------------------------- wagering

/**
 * Status de uma submissão aceita (erros passam pelo HttpErrorFilter):
 *   PROCESSED novo → 201 · replay de PROCESSED → 200
 *   PENDING_REFERENCE → 202 (aceito, processamento pendente)
 *   REJECTED → 422 com failureCode (novo ou replay — mesmo corpo, idempotentReplay distingue)
 *   FAILED → 500 com failureCode (terminal, auditável)
 */
export function statusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: WagerTransactionPayload,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const result = await this.submit.execute({ idempotencyKey, payload: body, source: "http", correlationId });
    res.status(statusFor(result));
    const { transactionId, status, balance, failureCode, referenceTransactionId, idempotentReplay } = result;
    return {
      transactionId,
      status,
      ...(balance ? { balance } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(referenceTransactionId ? { referenceTransactionId } : {}),
      idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  getTransaction(@Param("transactionId") transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

// ---------------------------------------------------------------- health & metrics

@Public()
@Controller()
export class OperationsController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: o processo responde. Não toca dependências (reiniciar não cura o banco). */
  @Get("health/live")
  live() {
    return { status: "ok", instanceId: this.config.instanceId };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 tira a instância do balanceador. */
  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.fork().getConnection().execute("SELECT 1")),
      probe(() => checkSqs(this.sqs, this.config.sqs.transactionsQueueUrl)),
    ]);
    const ok = postgres.ok && sqs.ok;
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks: { postgres, sqs }, instanceId: this.config.instanceId };
  }

  @Get("metrics")
  async metricsEndpoint(@Res() res: Response) {
    res.setHeader("Content-Type", this.metrics.contentType());
    res.send(await this.metrics.render());
  }
}

async function probe(fn: () => Promise<unknown>, timeoutMs = 2_000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}
