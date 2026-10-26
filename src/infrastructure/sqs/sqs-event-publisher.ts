import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { IntegrationEventPublisher, PublishResult } from "@/wagering/application/outbox-relay";
import type { OutboxMessage } from "@/wagering/domain/outbox-message";

const SQS_BATCH_LIMIT = 10;

/**
 * Publica envelopes da outbox numa fila SQS FIFO.
 *
 * - MessageGroupId = aggregateId: eventos do mesmo agregado (wallet ou transação) são entregues
 *   em ordem ao consumidor; agregados diferentes fluem em paralelo.
 * - MessageDeduplicationId = eventId: o SQS descarta republicações em até 5 min (otimização);
 *   a garantia final é o consumidor deduplicar por eventId.
 * - Resultado por mensagem: falha parcial do lote reagenda só as que falharam.
 */
export class SqsEventPublisher implements IntegrationEventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: "String", StringValue: m.eventType },
                eventId: { DataType: "String", StringValue: m.id },
              },
            })),
          }),
        );
        const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f]));
        chunk.forEach((m, index) => {
          const failure = failed.get(String(index));
          results.push(failure ? { id: m.id, ok: false, error: `${failure.Code}: ${failure.Message ?? ""}` } : { id: m.id, ok: true });
        });
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        chunk.forEach((m) => results.push({ id: m.id, ok: false, error: reason }));
      }
    }
    return results;
  }
}
