export type TransactionSource = "http" | "sqs" | "reference-worker";
export type DuplicateKind = "idempotency_replay" | "inbox_redelivery" | "outbox_republish";

export interface WageringMetrics {
  transactionOutcome(status: string, kind: string, source: TransactionSource): void;
  duplicateDetected(kind: DuplicateKind): void;
  retry(operation: string, reason: string): void;
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
