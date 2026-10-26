#!/bin/bash
set -euo pipefail

# DLQ primeiro, para obter o ARN usado na redrive policy da fila principal.
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# maxReceiveCount=5: após 5 entregas sem ack a mensagem vai para a DLQ.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Fila onde o outbox publisher entrega os eventos de integração.
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready"
