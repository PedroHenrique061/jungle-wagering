import { OUTBOX_RETRY_POLICY, nextAttemptAt, type BackoffPolicy } from "./retry-policy";
import type { IntegrationEvent } from "./events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Evento de integração pendente de publicação. Gravado na mesma transação SQL
 * do efeito financeiro; publicado depois por um worker (at-least-once).
 * `id` = eventId do envelope, para o consumidor deduplicar publicações repetidas.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    // Garante que o payload é JSON puro (sem Money, Date etc.) antes de ir para o banco.
    const payload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, Object.freeze(payload), event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt) return; // publicar de novo é seguro; o primeiro registro vence
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto). */
  scheduleRetry(now: Date, policy: BackoffPolicy = OUTBOX_RETRY_POLICY): void {
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(policy, this._attempts - 1, now);
  }

  /** Atraso entre a ocorrência e agora — base da métrica de outbox lag. */
  lagMs(now: Date): number {
    return Math.max(0, now.getTime() - this.occurredAt.getTime());
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}
