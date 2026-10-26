# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores de jogos por **HTTP** e por **SQS**, mantendo saldo e ledger consistentes com **entrega at-least-once, mensagens fora de ordem e várias instâncias concorrentes**.

As decisões de projeto, os trade-offs e as limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Stack

| Item | Escolha |
| --- | --- |
| Runtime, package manager e test runner | Bun 1.x |
| Linguagem | TypeScript (strict, `noUncheckedIndexedAccess`) |
| Framework | NestJS 11 |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 6 (`EntitySchema`, `em.transactional()`, `LockMode`) |
| Mensageria | AWS SQS FIFO via LocalStack |
| Métricas | Prometheus (`prom-client`) |
| Orquestração local | Docker Compose (3 réplicas da aplicação) |

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose v2 (Docker Desktop, Colima ou equivalente)

## Início rápido

```bash
bun install
cp .env.example .env

bun run infra:up            # PostgreSQL + LocalStack; espera os healthchecks (filas FIFO e DLQ criadas)
bun run db:migrate          # aplica as migrations

bun run test                # unitários
bun run test:integration    # integração (PostgreSQL e LocalStack reais)
bun run test:concurrency    # concorrência (3 instâncias e 3 processos)

bun run app:up              # 3 réplicas da aplicação nas portas 3000, 3001 e 3002
```

Para rodar uma única instância fora do Docker (com hot reload): `bun run dev`.

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run infra:up` / `infra:down` | Sobe PostgreSQL e LocalStack e **espera ficarem saudáveis** (`--wait`) / derruba tudo, inclusive as réplicas, e apaga os volumes |
| `bun run db:migrate` | Aplica as migrations pendentes |
| `bun run db:rollback` | Desfaz a última migration |
| `bun run db:status` | Lista migrations executadas e pendentes |
| `bun run db:reset` | Desfaz todas e reaplica (prova que o `down` é completo) |
| `bun run app:up` / `app:down` | Sobe/derruba o serviço de migrations e as 3 réplicas da aplicação |
| `bun run dev` / `start` | Uma instância local (com/sem watch) |
| `bun run sqs:send <walletId> <playerId> <kind> <amount> [ref] [externalId]` | Publica uma `WagerTransactionRequested` na fila |
| `bun run test` | 119 testes unitários do domínio (sem infraestrutura) |
| `bun run test:integration` | 70 testes de integração (exige `infra:up`) |
| `bun run test:concurrency` | 8 testes de concorrência (exige `infra:up`) |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |

Os testes de integração e de concorrência criam **um banco PostgreSQL por arquivo** (`wagering_test_*`) e **filas próprias no LocalStack**. Por isso não interferem nas réplicas do Docker e podem rodar com a aplicação no ar.

## Variáveis de ambiente

| Variável | Default | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | obrigatória | Conexão PostgreSQL |
| `DB_POOL_MAX` | `10` | Conexões por instância |
| `SQS_ENDPOINT` | — | Endpoint do LocalStack (vazio = AWS real) |
| `SQS_TRANSACTIONS_QUEUE_URL` | obrigatória | Fila de entrada `wager-transactions.fifo` |
| `SQS_TRANSACTIONS_DLQ_URL` | derivada (`-dlq.fifo`) | DLQ da fila de entrada |
| `SQS_EVENTS_QUEUE_URL` | obrigatória | Fila onde a outbox publica os eventos |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Deve ser igual ao `maxReceiveCount` da redrive policy |
| `SQS_WAIT_TIME_SECONDS` | `10` | Long polling |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibilidade de cada mensagem recebida |
| `ROLE_CONSUMER` / `ROLE_OUTBOX_PUBLISHER` / `ROLE_REFERENCE_WORKER` | `true` | Papéis de background desta instância |
| `INSTANCE_ID` | `hostname-xxxxxx` | Identifica a instância em logs, métricas e leases |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error` |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `us-east-1` / `test` / `test` | Credenciais (LocalStack aceita qualquer valor) |

## API HTTP

Dinheiro é sempre `{ "amount": "25.00", "currency": "BRL" }`, com o valor como **string decimal** de no máximo 2 casas. `number`, notação científica, `NaN` e negativos são recusados com `400`.

| Método e rota | Descrição |
| --- | --- |
| `POST /wallets` | Cria wallet (saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` na mesma transação) |
| `GET /wallets/:walletId` | Saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado (cursor opaco, `limit` 1..200) |
| `POST /wallets/:walletId/reconciliation` | Compara saldo materializado com o saldo reconstruído do ledger |
| `POST /wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness · readiness (PostgreSQL + SQS). Sem autenticação |
| `GET /metrics` | Métricas Prometheus. Sem autenticação |

### Status HTTP

O mapeamento é o mesmo em todos os endpoints. Todo erro devolve `{ error: { code, message, retryable }, correlationId }`, então o provedor decide se reenvia pelo `code` e pelo `retryable`, sem interpretar mensagem.

| Status | Situação | Reenviar? |
| --- | --- | --- |
| `201` | Transação nova aplicada (ou wallet criada) | — |
| `200` | Replay idempotente de transação já processada (`idempotentReplay: true`) | — |
| `202` | Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | Não; consulte depois |
| `400` | Payload ou header inválido | Não; corrigir |
| `404` | Recurso inexistente (consultas) | Não |
| `409` | Conflito de idempotência (mesma chave, payload diferente) ou duplicidade | Não |
| `422` | Rejeição por regra de negócio, com `failureCode` | Não; ver `failureCode` |
| `503` | Falha transitória (banco/fila, lock) + `Retry-After` | **Sim, com a mesma `Idempotency-Key`** |
| `500` | Erro inesperado | Não automaticamente |

### Exemplo

```bash
# 1. cria a wallet e guarda o id
WALLET=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}' \
  | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)')

# 2. aposta em uma instância...
curl -s -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"player-1\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"; echo
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}

# 3. ...e o MESMO comando do passo 2 enviado à porta 3002 é replay, sem novo débito
# → 200 {… mesmo transactionId, "balance":{"amount":"75.00"}, "idempotentReplay":true}

# 4. pela fila
bun run sqs:send $WALLET player-1 BET 10.00

# 5. consistência
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation; echo
# → {"storedBalance":{"amount":"65.00",…},"calculatedBalance":{"amount":"65.00",…},"difference":{"amount":"0.00",…},"consistent":true,"checkedEntries":3}
```

## Mensageria

| Fila | Papel |
| --- | --- |
| `wager-transactions.fifo` | Entrada (`WagerTransactionRequested`). Redrive para a DLQ após 5 recebimentos |
| `wager-transactions-dlq.fifo` | Mensagens com erro permanente (com `failureReason`) ou com retries esgotados |
| `wagering-events.fifo` | Eventos de integração publicados pela outbox |

Eventos publicados: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`. O consumidor deve deduplicar por `eventId`, e pode usar `walletVersion` para ordenar `WalletBalanceChanged`.

## Observabilidade

- **Logs**: uma linha JSON por evento, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `instanceId`. Valores monetários e payloads são redigidos pelo nome do campo. O header `X-Correlation-Id` é aceito e devolvido.
- **Métricas** (`GET /metrics`): transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox pendente e lag, latência de processamento e reconciliações. A lista completa está em [ARCHITECTURE.md](./ARCHITECTURE.md#15-observabilidade).
- **Health**: `/health/live` (processo) e `/health/ready` (PostgreSQL e SQS, com latência de cada um).

## Estrutura

```
src/
  shared/            Money, erros base, UUIDv7, JSON canônico, logger, laço de polling
  wagering/
    domain/          Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos,
                     WagerSettlement (regras de negócio), failure codes, políticas de retry
    application/     use cases, portas (repositórios, UnitOfWork, métricas, publisher)
  infrastructure/    MikroORM (schemas, mappers, repositórios, migrations), SQS, Prometheus
  interfaces/        HTTP (controllers, filtro de erros, auth guard), consumidor SQS, workers
  app.module.ts      composição explícita dos providers
  main.ts            bootstrap
scripts/             migrate.ts, send-wager-message.ts
tests/
  unit/              domínio puro
  integration/       schema, API HTTP, mensageria (PostgreSQL + LocalStack reais)
  concurrency/       paralelismo real: 3 instâncias no processo e 3 processos separados
infra/localstack/    criação das filas
```
