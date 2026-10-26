import type { Logger } from "@/shared/observability/logger";
import type { OutboxMessage } from "../domain/outbox-message";
import type { BackoffPolicy } from "../domain/retry-policy";
import type { WageringMetrics } from "./metrics";
import type { UnitOfWork } from "./ports";

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Porta de publicação de eventos de integração (implementação: SQS FIFO). */
export interface IntegrationEventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishResult[]>;
}

export interface OutboxRelayOptions {
  workerId: string;
  batchSize?: number;
  /** Tempo de posse de um lote. Se o publisher morrer, outra instância assume após o lease. */
  leaseMs?: number;
  retryPolicy?: BackoffPolicy;
  clock?: () => Date;
}

/**
 * Publisher da Transactional Outbox (seção 11). At-least-once:
 *
 *   1. claim com lease (SKIP LOCKED) — transação curta, commitada antes de publicar;
 *   2. publica FORA de transação SQL (não segura conexão/lock durante I/O de rede);
 *   3. marca publicado; falha → attempts++ e próxima tentativa com backoff.
 *
 * Morreu entre 2 e 3 → o lease expira, outra instância republica. Duplicata é segura:
 * o consumidor deduplica por `eventId` (e o SQS FIFO ainda deduplica por 5 min via
 * MessageDeduplicationId = eventId — otimização, não garantia).
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: () => Date;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: IntegrationEventPublisher,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly options: OutboxRelayOptions,
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Um ciclo: reivindica, publica e registra o resultado. Retorna quantas mensagens tratou. */
  async relayOnce(): Promise<number> {
    const claimed = await this.uow.run((r) =>
      r.outbox.claimDue(this.clock(), this.batchSize, this.options.workerId, this.leaseMs),
    );
    if (claimed.length === 0) return 0;

    let results: PublishResult[];
    try {
      results = await this.publisher.publish(claimed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results = claimed.map((m) => ({ id: m.id, ok: false, error: reason }));
    }
    const byId = new Map(results.map((r) => [r.id, r]));

    const published: OutboxMessage[] = [];
    const failed: { message: OutboxMessage; error: string }[] = [];
    const now = this.clock();
    for (const message of claimed) {
      const result = byId.get(message.id);
      if (result?.ok) {
        message.markPublished(now);
        published.push(message);
      } else {
        message.scheduleRetry(now, this.options.retryPolicy);
        failed.push({ message, error: result?.error ?? "no publish result" });
      }
    }

    await this.uow.run(async (r) => {
      for (const message of published) await r.outbox.markPublished(message, this.options.workerId);
      for (const { message, error } of failed) await r.outbox.scheduleRetry(message, this.options.workerId, error);
    });

    if (published.length) this.metrics.outboxPublished(published.length);
    for (const { message, error } of failed) {
      this.metrics.retry("outbox_publish", "publish_failed");
      this.logger.warn("outbox publish failed, rescheduled", {
        eventId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        reason: error,
      });
    }
    return claimed.length;
  }

  /** Atualiza as métricas de backlog e lag (idade do evento pendente mais antigo). */
  async reportState(): Promise<{ pending: number; lagSeconds: number }> {
    const stats = await this.uow.run((r) => r.outbox.stats());
    const lagSeconds = stats.oldestPendingOccurredAt
      ? Math.max(0, (this.clock().getTime() - stats.oldestPendingOccurredAt.getTime()) / 1000)
      : 0;
    this.metrics.outboxState(stats.pending, lagSeconds);
    return { pending: stats.pending, lagSeconds };
  }
}
