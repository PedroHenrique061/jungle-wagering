import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { DomainError } from "@/shared/domain/domain-error";
import type { Logger } from "@/shared/observability/logger";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  UnprocessableTransactionError,
} from "@/wagering/application/errors";
import type { WageringMetrics } from "@/wagering/application/metrics";
import type {
  SubmitWagerCommand,
  SubmitWagerOutcome,
  WagerTransactionPayload,
} from "@/wagering/application/submit-wager-transaction";
import { isTransient } from "@/wagering/application/transient-retry";
import { InvalidTransactionStateError } from "@/wagering/domain/errors";

export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";
export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: typeof WAGER_MESSAGE_TYPE;
  occurredAt?: string;
  correlationId?: string;
  data: WagerTransactionPayload & { idempotencyKey: unknown };
}

export interface WagerSubmitter {
  execute(command: SubmitWagerCommand): Promise<SubmitWagerOutcome>;
}

export interface ConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  maxReceiveCount: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxMessages?: number;
  maxBackoffSeconds?: number;
  crashBeforeAck?: (message: Message) => boolean;
}

export type ErrorClass = "business" | "transient" | "permanent";

export function classifyError(error: unknown): ErrorClass {
  if (isTransient(error)) return "transient";
  if (error instanceof InvalidTransactionStateError) return "permanent";
  if (
    error instanceof DomainError ||
    error instanceof InvalidRequestError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof UnprocessableTransactionError
  ) {
    return "business";
  }
  return "permanent";
}

class MalformedMessageError extends Error {
  readonly code = "MALFORMED_MESSAGE";
}

export class WagerTransactionConsumer {
  private readonly maxMessages: number;
  private readonly maxBackoffSeconds: number;

  constructor(
    private readonly sqs: SQSClient,
    private readonly submitter: WagerSubmitter,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions,
  ) {
    this.maxMessages = Math.min(options.maxMessages ?? 10, 10);
    this.maxBackoffSeconds = options.maxBackoffSeconds ?? 60;
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0;
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: signal },
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) return 0;

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "default";
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          if (signal?.aborted) await this.release(message);
          else await this.handle(message);
        }
      }),
    );
    return messages.length;
  }

  async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const base = { sqsMessageId: message.MessageId, receiveCount };

    let envelope: WagerTransactionRequestedMessage;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      await this.sendToDlq(message, "MALFORMED_MESSAGE", error);
      return;
    }

    const log = this.logger.child({
      ...base,
      messageId: envelope.messageId,
      correlationId: envelope.correlationId ?? envelope.messageId,
      providerId: typeof envelope.data.providerId === "string" ? envelope.data.providerId : undefined,
      walletId: typeof envelope.data.walletId === "string" ? envelope.data.walletId : undefined,
    });

    let outcome: SubmitWagerOutcome;
    try {
      outcome = await this.submitter.execute({
        idempotencyKey: envelope.data.idempotencyKey,
        payload: envelope.data,
        source: "sqs",
        correlationId: envelope.correlationId ?? envelope.messageId,
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
      });
    } catch (error) {
      await this.onFailure(message, receiveCount, error, log);
      return;
    }

    // daqui em diante o commit já aconteceu: perder o ack só gera redelivery, que a inbox descarta
    if (this.options.crashBeforeAck?.(message)) {
      log.warn("simulated crash after commit and before ack", { transactionId: outcome.transactionId });
      return;
    }
    await this.ack(message, log);
  }

  private async onFailure(message: Message, receiveCount: number, error: unknown, log: Logger): Promise<void> {
    const kind = classifyError(error);
    const code = (error as { failureCode?: string; code?: string }).failureCode ?? (error as { code?: string }).code ?? "UNKNOWN";

    if (kind === "business") {
      log.warn("message rejected by business rule, acknowledged", { code, error });
      await this.ack(message, log);
      return;
    }

    if (kind === "transient") {
      if (receiveCount >= this.options.maxReceiveCount) {
        // sem ack: na próxima entrega a redrive policy move a mensagem para a DLQ
        this.metrics.dlqMessage("retries_exhausted");
        log.error("transient failure on last attempt, message goes to DLQ via redrive", { code, error });
      } else {
        this.metrics.retry("sqs_consume", code);
        log.warn("transient failure, message will be redelivered", { code, error });
      }
      await this.changeVisibility(message, this.backoffSeconds(receiveCount), log);
      return;
    }

    await this.sendToDlq(message, code, error);
  }

  private async sendToDlq(message: Message, reason: string, error: unknown): Promise<void> {
    const log = this.logger.child({ sqsMessageId: message.MessageId });
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: "String", StringValue: reason },
            sourceMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
            receiveCount: {
              DataType: "Number",
              StringValue: message.Attributes?.ApproximateReceiveCount ?? "1",
            },
          },
        }),
      );
    } catch (sendError) {
      log.error("could not move message to DLQ, leaving it for redelivery", { reason, error: sendError });
      return;
    }
    this.metrics.dlqMessage(reason);
    log.error("message moved to DLQ", { reason, error });
    await this.ack(message, log);
  }

  private async ack(message: Message, log: Logger): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      log.warn("ack failed, message will be redelivered and deduplicated", { error });
    }
  }

  private async release(message: Message): Promise<void> {
    await this.changeVisibility(message, 0, this.logger);
  }

  private async changeVisibility(message: Message, seconds: number, log: Logger): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      log.warn("could not change message visibility; it will reappear after the visibility timeout", { error });
    }
  }

  private backoffSeconds(receiveCount: number): number {
    return Math.min(2 ** Math.max(1, receiveCount), this.maxBackoffSeconds);
  }
}

function parseEnvelope(body: string | undefined): WagerTransactionRequestedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw new MalformedMessageError("body is not valid JSON");
  }
  const e = parsed as Partial<WagerTransactionRequestedMessage> | null;
  if (!e || typeof e !== "object") throw new MalformedMessageError("body must be an object");
  if (e.type !== WAGER_MESSAGE_TYPE) throw new MalformedMessageError(`unsupported type ${String(e.type)}`);
  if (typeof e.messageId !== "string" || e.messageId.trim() === "" || e.messageId.length > 256) {
    throw new MalformedMessageError("messageId must be a non-empty string");
  }
  if (!e.data || typeof e.data !== "object") throw new MalformedMessageError("data must be an object");
  return e as WagerTransactionRequestedMessage;
}
