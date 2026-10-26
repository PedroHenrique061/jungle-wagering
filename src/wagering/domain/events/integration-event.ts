import { uuidv7 } from "@/shared/domain/uuid";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto de rastreio propagado da entrada (HTTP/fila) até os eventos. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  /** Opcional: permite ids determinísticos em testes. */
  eventId?: string;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração. `eventType` e `version` ficam no tipo
 * (subclasse concreta), nunca numa string solta no call site.
 * `data` só carrega JSON estável (MoneyProps, ISO strings) — nunca instâncias de domínio.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  protected static props<T>(aggregateId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
    return {
      eventId: ctx.eventId ?? uuidv7(ctx.occurredAt.getTime()),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
    if (this.causationId) envelope.causationId = this.causationId;
    return envelope;
  }
}
