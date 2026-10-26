import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { DuplicateKind, TransactionSource, WageringMetrics } from "@/wagering/application/metrics";

/**
 * Métricas expostas em GET /metrics (formato Prometheus). Registry próprio por instância
 * da aplicação — cada réplica expõe as suas, e o Prometheus agrega por label `instance`.
 */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions handled, by resulting status",
    labelNames: ["status", "kind", "source"] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicates detected (idempotent replays, inbox redeliveries, outbox republish)",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Automatic retries by operation and reason",
    labelNames: ["operation", "reason"] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Concurrency conflicts on wallets (lock timeout, deadlock, version conflict)",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages that exhausted retries and were left for the DLQ",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager transaction",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox messages published",
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Outbox messages not yet published",
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message",
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean; instanceId?: string } = {}) {
    if (options.instanceId) this.registry.setDefaultLabels({ instance_id: options.instanceId });
    if (options.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry });
  }

  transactionOutcome(status: string, kind: string, source: TransactionSource): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }
  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  processingLatency(source: TransactionSource, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }
  reconciliation(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "mismatch" });
  }
  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }
  outboxState(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
