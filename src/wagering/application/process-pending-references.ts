import type { Logger } from "@/shared/observability/logger";
import type { BackoffPolicy } from "../domain/retry-policy";
import type { SettlementOutcome } from "../domain/wager-settlement";
import { PermanentInfrastructureError } from "./errors";
import type { WageringMetrics } from "./metrics";
import type { UnitOfWork } from "./ports";
import { withTransientRetry } from "./transient-retry";
import { settleAndPersist } from "./wager-processing";

export interface ProcessPendingReferencesOptions {
  policy?: BackoffPolicy;
  clock?: () => Date;
}

/**
 * Worker de PENDING_REFERENCE (seção 7.1). Cada transação vencida é reavaliada na sua própria
 * transação SQL:
 *
 *   claim (FOR UPDATE SKIP LOCKED) → lock da wallet → settleAndPersist(isNew = false)
 *
 * - Várias instâncias rodam o worker ao mesmo tempo sem pegar a mesma linha (SKIP LOCKED).
 * - Referência chegou → aplica normalmente. Ainda ausente → reagenda com backoff exponencial.
 * - Tentativas esgotadas → REJECTED/REFERENCE_NOT_FOUND + WagerTransactionRejected na outbox.
 *
 * Ordem de locks (transação → wallet) não conflita com a entrada HTTP/fila (wallet → insert):
 * a entrada só toca linhas pendentes via `wakeDependents`, que usa SKIP LOCKED e nunca espera.
 */
export class ProcessPendingReferences {
  private readonly clock: () => Date;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly options: ProcessPendingReferencesOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Processa até `max` transações vencidas. Retorna quantas foram reavaliadas. */
  async processBatch(max: number, signal?: AbortSignal): Promise<number> {
    let processed = 0;
    while (processed < max && !signal?.aborted) {
      const handled = await this.processNext();
      if (!handled) break;
      processed++;
    }
    return processed;
  }

  /** Reavalia a próxima transação vencida. Retorna false se não havia nenhuma. */
  async processNext(): Promise<boolean> {
    const started = performance.now();
    const result = await withTransientRetry(
      () =>
        this.uow.run(async (repos) => {
          const now = this.clock();
          const [id] = await repos.transactions.claimDuePendingReferences(now, 1);
          if (!id) return undefined;

          const tx = await repos.transactions.findById(id);
          if (!tx) return undefined;
          const wallet = await repos.wallets.lockById(tx.walletId);
          if (!wallet) {
            // Impossível com a FK; se acontecer é corrupção — não adianta repetir.
            throw new PermanentInfrastructureError(`wallet ${tx.walletId} of pending transaction ${tx.id} not found`);
          }
          const outcome: SettlementOutcome = await settleAndPersist(repos, tx, wallet, {
            isNew: false,
            correlationId: tx.id,
            causationId: "pending-reference-worker",
            now,
            policy: this.options.policy,
          });
          return { tx, outcome };
        }),
      { operation: "process_pending_reference", maxAttempts: 3, baseDelayMs: 20, metrics: this.metrics },
    );
    if (!result) return false;

    const { tx, outcome } = result;
    this.metrics.transactionOutcome(tx.status, tx.kind, "reference-worker");
    if (outcome.type !== "PENDING_REFERENCE") {
      this.metrics.processingLatency("reference-worker", (performance.now() - started) / 1000);
    }
    const log = outcome.type === "REJECTED" ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger);
    log("pending reference re-evaluated", {
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
      attempts: tx.referenceAttempts,
    });
    return true;
  }
}
