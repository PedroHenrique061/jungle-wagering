/**
 * Porta de métricas. A aplicação só conhece esta interface; a implementação
 * Prometheus fica em infrastructure/observability.
 */
export type TransactionSource = "http" | "sqs" | "reference-worker";
export type DuplicateKind = "idempotency_replay" | "inbox_redelivery" | "outbox_republish";

export interface WageringMetrics {
  /** Transações por status final da operação (inclui replays com o status original). */
  transactionOutcome(status: string, kind: string, source: TransactionSource): void;
  duplicateDetected(kind: DuplicateKind): void;
  /** Uma nova tentativa automática de uma operação (use case, consumer, publisher). */
  retry(operation: string, reason: string): void;
  /** Conflito de concorrência na wallet: lock timeout, deadlock, conflito de versão. */
  lockConflict(reason: string): void;
  dlqMessage(reason: string): void;
  processingLatency(source: TransactionSource, seconds: number): void;
  reconciliation(consistent: boolean): void;
  outboxPublished(count: number): void;
  outboxState(pending: number, lagSeconds: number): void;
}

export const NOOP_METRICS: WageringMetrics = {
  transactionOutcome: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  dlqMessage: () => {},
  processingLatency: () => {},
  reconciliation: () => {},
  outboxPublished: () => {},
  outboxState: () => {},
};

export const WAGERING_METRICS = Symbol("WageringMetrics");
