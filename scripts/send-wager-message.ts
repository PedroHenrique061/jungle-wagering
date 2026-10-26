import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "@/config";
import { createSqsClient } from "@/infrastructure/sqs/sqs-client";
import { uuidv7 } from "@/shared/domain/uuid";

/**
 * Publica uma WagerTransactionRequested na fila de entrada (demonstração/manual).
 *
 *   bun run sqs:send <walletId> <playerId> <kind> <amount> [referenceExternalTransactionId] [externalTransactionId]
 *
 * Exemplo:
 *   bun run sqs:send $WALLET player-3 BET 10.00
 */
const [walletId, playerId, kind = "BET", amount = "10.00", reference, externalIdArg] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error("usage: bun run sqs:send <walletId> <playerId> <kind> <amount> [referenceExternalTransactionId] [externalTransactionId]");
  process.exit(1);
}

const config = loadConfig();
const sqs = createSqsClient(config);
const externalTransactionId = externalIdArg ?? `sqs-${uuidv7()}`;
const message = {
  messageId: `msg-${uuidv7()}`,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "round-cli",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  },
};

await sqs.send(
  new SendMessageCommand({
    QueueUrl: config.sqs.transactionsQueueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: walletId,
    MessageDeduplicationId: message.messageId,
  }),
);
console.log(JSON.stringify({ sent: message.messageId, externalTransactionId, kind, amount }));
sqs.destroy();
