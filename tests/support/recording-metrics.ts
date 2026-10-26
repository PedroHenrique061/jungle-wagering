import type { DuplicateKind, TransactionSource, WageringMetrics } from "@/wagering/application/metrics";

/** Métricas que só registram chamadas — para os testes afirmarem o que foi contado. */
export class RecordingMetrics implements WageringMetrics {
  readonly outcomes: { status: string; kind: string; source: TransactionSource }[] = [];
  readonly duplicates: DuplicateKind[] = [];
  readonly retries: { operation: string; reason: string }[] = [];
  readonly lockConflicts: string[] = [];
  readonly dlq: string[] = [];
  published = 0;

  transactionOutcome(status: string, kind: string, source: TransactionSource): void {
    this.outcomes.push({ status, kind, source });
  }
  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.push(kind);
  }
  retry(operation: string, reason: string): void {
    this.retries.push({ operation, reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.push(reason);
  }
  dlqMessage(reason: string): void {
    this.dlq.push(reason);
  }
  processingLatency(): void {}
  reconciliation(): void {}
  outboxPublished(count: number): void {
    this.published += count;
  }
  outboxState(): void {}
}
