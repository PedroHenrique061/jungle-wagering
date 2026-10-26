import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { uuidv7 } from "@/shared/domain/uuid";
import { TEST_ENV } from "./test-app";

export interface TestQueues {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  maxReceiveCount: number;
  send(body: unknown, groupId: string): Promise<void>;
  count(url: string): Promise<number>;
  drain(url: string, rounds?: number): Promise<Message[]>;
  destroy(): Promise<void>;
}

export async function createTestQueues(
  prefix: string,
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const maxReceiveCount = options.maxReceiveCount ?? 3;
  const sqs = new SQSClient({
    region: TEST_ENV.AWS_REGION,
    endpoint: TEST_ENV.SQS_ENDPOINT,
    credentials: { accessKeyId: TEST_ENV.AWS_ACCESS_KEY_ID, secretAccessKey: TEST_ENV.AWS_SECRET_ACCESS_KEY },
  });
  const name = `t-${prefix}-${uuidv7().slice(-8)}`;

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: { FifoQueue: "true" } }));
  const dlqUrl = dlq.QueueUrl!;
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}.fifo`,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 1),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attrs.Attributes!.QueueArn, maxReceiveCount }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-ev.fifo`, Attributes: { FifoQueue: "true" } }));
  const queueUrl = main.QueueUrl!;
  const eventsUrl = events.QueueUrl!;

  return {
    sqs,
    queueUrl,
    dlqUrl,
    eventsUrl,
    maxReceiveCount,
    async send(body, groupId) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === "string" ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: uuidv7(),
        }),
      );
    },
    async count(url) {
      const r = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    },
    async drain(url, rounds = 3) {
      const all: Message[] = [];
      for (let i = 0; i < rounds; i++) {
        const r = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
          }),
        );
        const messages = r.Messages ?? [];
        if (messages.length === 0 && i > 0) break;
        for (const m of messages) {
          all.push(m);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
        }
      }
      return all;
    },
    async destroy() {
      for (const url of [queueUrl, dlqUrl, eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
      }
      sqs.destroy();
    },
  };
}
