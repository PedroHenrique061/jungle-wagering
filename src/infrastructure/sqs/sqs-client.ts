import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "@/config";

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
    maxAttempts: 3,
  });
}

export async function checkSqs(client: SQSClient, queueUrl: string, timeoutMs = 2_000): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }), {
      abortSignal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const SQS_CLIENT = Symbol("SQSClient");
