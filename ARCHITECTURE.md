# Arquitetura

Este documento registra **o que foi decidido, por quê, o que se perdeu em troca e o que ficou de fora**. A regra que orienta tudo: **o banco é o guardião final das invariantes**. Código de aplicação, locks, ordenação do SQS e retries são camadas de defesa e de desempenho; a garantia está no schema e nas transações do PostgreSQL.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Camadas e fronteiras](#2-camadas-e-fronteiras)
3. [Money](#3-money)
4. [ORM e estratégia transacional](#4-orm-e-estratégia-transacional)
5. [Modelo de domínio](#5-modelo-de-domínio)
6. [Regras de negócio e interpretações](#6-regras-de-negócio-e-interpretações)
7. [Códigos de falha](#7-códigos-de-falha)
8. [Concorrência](#8-concorrência)
9. [Idempotência](#9-idempotência)
10. [Garantias no schema](#10-garantias-no-schema)
11. [Consumo de SQS](#11-consumo-de-sqs)
12. [Transactional Outbox](#12-transactional-outbox)
13. [Referências fora de ordem](#13-referências-fora-de-ordem)
14. [API HTTP](#14-api-http)
15. [Observabilidade](#15-observabilidade)
16. [Autenticação](#16-autenticação)
17. [Estratégia de testes](#17-estratégia-de-testes)
18. [Trade-offs e limitações](#18-trade-offs-e-limitações)

---

## 1. Visão geral

```
 HTTP ─────────┐                                   ┌──────────── PostgreSQL ─────────────┐
 POST /wagering │                                   │ wallets            (saldo, version)  │
 /transactions  ├──► SubmitWagerTransaction ───────►│ wager_transactions (estado, resultado)│
                │    (o MESMO use case)             │ wallet_ledger_entries (append-only)  │
 SQS FIFO ──────┘     uma transação SQL:            │ inbox_messages     (dedup da fila)   │
 wager-transactions    lock wallet → inbox →        │ outbox_messages    (eventos a publicar)
   .fifo               idempotência → liquidação →  └──────────┬──────────────┬───────────┘
   │                   ledger → outbox → COMMIT                │              │
   ▼ (5 entregas)                                              │              │
 DLQ                     ProcessPendingReferences ◄────────────┘              │
                         (PENDING_REFERENCE vencidas, SKIP LOCKED)            │
                                                                              ▼
                         OutboxRelay (lease + SKIP LOCKED) ──► SQS FIFO wagering-events.fifo
```

Cada instância é **sem estado** e roda, conforme as flags `ROLE_*`, quatro papéis: HTTP, consumidor SQS, worker de referências e publisher da outbox. O Compose sobe 3 réplicas iguais; qualquer uma atende qualquer requisição.

## 2. Camadas e fronteiras

| Camada | Conteúdo | Depende de |
| --- | --- | --- |
| `wagering/domain` | Agregados, value objects, `WagerSettlement`, eventos, failure codes | só `shared/domain` |
| `wagering/application` | Use cases e **portas** (`UnitOfWork`, repositórios, `WageringMetrics`, `IntegrationEventPublisher`) | domínio |
| `infrastructure` | MikroORM, migrations, SQS, Prometheus (implementam as portas) | aplicação, domínio |
| `interfaces` | Controllers HTTP, consumidor SQS, workers | aplicação |

- O domínio não importa NestJS, MikroORM nem AWS SDK. Os 119 testes unitários rodam sem nenhuma dependência instalada.
- A composição fica explícita em `app.module.ts`: todo provider é criado por factory e token, sem depender de `emitDecoratorMetadata` para resolver tipos em runtime.
- **`WagerSettlement`** é um serviço de domínio puro: recebe a transação, a wallet já travada, a referência resolvida e o flag de "já revertida", decide e muta os objetos. Toda a regra de negócio da seção 7 está ali, testável sem I/O. O use case só carrega, trava e persiste.

## 3. Money

**Representação interna: `bigint` em unidades mínimas (centavos).** Como a escala é fixa em 2 casas, soma e subtração de inteiros são exatas por construção. Não existe arredondamento possível e não há dependência de biblioteca decimal. O esqueleto do README usa `Decimal`; a garantia ("nunca `number`, nunca float") é preservada.

| Aspecto | Decisão |
| --- | --- |
| Entrada externa | `Money.from({ amount, currency })`, só string, regex `^(0\|[1-9]\d*)(\.\d{1,2})?$`. Rejeita `number`, `""`, `NaN`, `Infinity`, `1e3`, `-1`, `+1`, `01.00`, `1.`, `1,00`, espaços e mais de 2 casas |
| Saída | `toJSON()` sempre com 2 casas (`"25.00"`); nunca produz `-0.00` nem notação científica |
| Persistência | `NUMERIC(20,2)` + `CHAR(3)`; lido como string e reidratado por `Money.fromPersistence` (que aceita sinal, para a diferença da reconciliação) |
| Moeda | ISO-4217 (`^[A-Z]{3}$`). Operações entre moedas lançam `CurrencyMismatchError`. O desafio usa só `BRL`, mas o modelo é multi-moeda e o conflito é testado |
| Imutabilidade | Construtor privado e `Object.freeze`; toda operação devolve uma nova instância |
| Hash de payload | `"25"` e `"25.00"` são o mesmo valor, logo o mesmo payload (normalização antes do hash) |

## 4. ORM e estratégia transacional

**MikroORM** (preferido pelo desafio), usado com estas decisões:

- **`EntitySchema` em classes de registro separadas do domínio** (`records.ts`) e conversão por `mappers.ts`, usando as factories `rehydrate`. O domínio tem construtores privados e estado encapsulado; mapear os agregados diretamente obrigaria a abrir o estado para o ORM. O custo é um mapper explícito por agregado.
- **`em.transactional()` num fork do EntityManager por unidade de trabalho** (`MikroOrmUnitOfWork`). Nenhum estado é compartilhado entre requisições, e o identity map é desligado nas leituras (`disableIdentityMap`), que são sempre frescas.
- **`LockMode.PESSIMISTIC_WRITE`** (`SELECT … FOR UPDATE`) na wallet.
- **SQL explícito onde a semântica importa mais que a abstração**: `nativeUpdate` condicional por versão, `ON CONFLICT DO NOTHING` na inbox e `FOR UPDATE SKIP LOCKED` na outbox e no worker. O ORM cuida de mapeamento, transação e locks; essas poucas instruções ficam visíveis no código porque são exatamente as que sustentam as garantias.
- **Migrations escritas à mão** em SQL (não geradas pelo ORM), listadas em `migrationsList`, cada uma numa transação, com `allOrNothing` e `down` completo. O teste `migrations são reversíveis` faz `down` até zero, confirma que nenhuma tabela ou função sobrou e faz `up` de novo.
- **Isolamento `READ COMMITTED`** + locks de linha. Ver §8.
- Em cada transação: `SET LOCAL lock_timeout = 5s` e `statement_timeout = 15s`, para que uma hot wallet nunca trave uma conexão indefinidamente.

## 5. Modelo de domínio

Todos os agregados têm construtor privado, factories (`create`/`open`/`receive`/`enqueue`) que validam e `rehydrate` que **não** revalida (reconstrói estado já persistido).

### Wallet (aggregate root)

- `debit`/`credit` são a **única** forma de mudar saldo e **devolvem o lançamento do ledger**. Não existe caminho para alterar saldo sem gerar lançamento.
- O lançamento é criado **antes** da mutação: se a factory do ledger recusar, a wallet fica intacta.
- `version` começa em 1 e incrementa **só** quando o saldo muda. A mesma regra está no banco (§10).

### WagerTransaction e máquina de estados

```
            ┌────────────► PROCESSED   (terminal)
            │
 PENDING ───┼────────────► REJECTED    (terminal, com failureCode)
     │      │
     │      └────────────► FAILED      (terminal, auditável)
     ▼
 PENDING_REFERENCE ──(nova verificação)──► PENDING_REFERENCE
     │
     └──► PROCESSED | REJECTED | FAILED
```

- A tabela `TRANSITIONS` é a única fonte das transições válidas. Qualquer outra lança `InvalidTransactionStateError`: erro de programação, não de negócio (HTTP 500, DLQ na fila).
- `resultBalance` guarda o saldo observado no momento em que a transação ficou terminal. É o que permite o replay devolver "o saldo observado naquele momento" (regra 7.7).
- `OPENING` só nasce por `WagerTransaction.opening()` (já `PROCESSED`); `create()` recusa `OPENING` vindo da API ou da fila.

### WalletLedgerEntry

Sem setters e sem transições, com a instância congelada. `create` valida `balanceBefore ± money === balanceAfter`, valor positivo e saldos não negativos. Uma transação gera no máximo um lançamento por wallet.

### Inbox, Outbox e eventos

- `IntegrationEvent<T>` é a classe abstrata; cada evento é uma subclasse com `eventType` e `version` **no tipo**. `data` só carrega JSON estável (`MoneyProps`, ISO-8601).
- `OutboxMessage.enqueue(event)` usa `eventId` como id da linha, que é a chave de deduplicação do consumidor.

## 6. Regras de negócio e interpretações

| Operação | Saldo | Ledger | Referência |
| --- | --- | --- | --- |
| `BET` | débito | 1 `DEBIT` | proibida |
| `WIN` | crédito | 1 `CREDIT` | opcional; se informada, deve ser `BET` |
| `LOSS` | — | — | opcional; se informada, deve ser `BET` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória; só `BET` |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | obrigatória; `BET`, `WIN` ou `REFUND` |

A ordem de validação em `WagerSettlement` é fixa, e a primeira falha define o `failureCode`:

1. a wallet pertence ao player e usa a moeda da operação;
2. a referência existe → não está pendente → está `PROCESSED` → é do mesmo provider, player, wallet, moeda e rodada → tem kind permitido → tem o mesmo valor → ainda não foi revertida;
3. há saldo para o débito.

**Interpretações adotadas além do texto do desafio:**

| # | Interpretação | Motivo |
| --- | --- | --- |
| 1 | **Reversão única por transação, somando `REFUND` e `ROLLBACK`.** O README proíbe reverter duas vezes "pelo mesmo tipo"; aqui, uma `BET` revertida por `REFUND` também não aceita `ROLLBACK` | `REFUND` + `ROLLBACK` da mesma `BET` creditariam duas vezes. Índice único parcial `wager_tx_single_reversal_uq` |
| 2 | `LOSS` aceita `0.00`; os demais kinds exigem valor > 0 | `LOSS` só registra resultado |
| 3 | `WIN`/`LOSS` com referência passam pelas mesmas validações das reversões e podem ficar `PENDING_REFERENCE` | Consistência: se o provedor informou a referência, ela precisa existir e ser válida |
| 4 | Referência que existe mas ainda está `PENDING`/`PENDING_REFERENCE` mantém a dependente esperando | Cadeias fora de ordem (`ROLLBACK` de um `WIN` que espera a `BET`) se resolvem sozinhas |
| 5 | Wallet inexistente → `422 WALLET_NOT_FOUND` **sem persistir** a transação | A FK impede registrar; não há wallet onde auditar. Na fila: erro de negócio (ack) |
| 6 | `(provider, externalTransactionId)` já registrado com **outra** chave → `409 EXTERNAL_TRANSACTION_ID_CONFLICT` | O id do provedor identifica a operação; chave nova para a mesma operação é erro do cliente |
| 7 | `Idempotency-Key` é única **por provider** | Provedores diferentes não colidem entre si |
| 8 | Rejeição de negócio é **persistida** como `REJECTED` (com o saldo observado) e gera evento | Auditável e replayável como qualquer resultado |

## 7. Códigos de falha

`failureCode` é estável e legível por máquina. O provedor decide pelo código:

| Código | Quando | Ação esperada do provedor |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | Desistir da aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` (de `WIN`/`REFUND`) deixaria saldo negativo | Escalar operacionalmente: o jogador já gastou o crédito |
| `CURRENCY_MISMATCH` | Moeda da operação ≠ moeda da wallet | Corrigir payload |
| `WALLET_NOT_FOUND` | `walletId` inexistente (não persistido) | Corrigir payload |
| `WALLET_PLAYER_MISMATCH` | Wallet não pertence ao `playerId` | Corrigir payload |
| `REFERENCE_NOT_FOUND` | Referência não chegou após as 12 verificações (~24 min) | Reenviar a referência e depois a reversão |
| `REFERENCE_MISMATCH` | Referência de outro provider, player, wallet, moeda ou rodada | Corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | Kind da referência não permitido (ex.: `REFUND` de `WIN`) | Corrigir payload |
| `REFERENCE_NOT_PROCESSED` | Referência terminou `REJECTED`/`FAILED` | Desistir |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida | Desistir (é o resultado esperado de um retry) |
| `REVERSAL_AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | Corrigir payload (reversão parcial está fora de escopo) |
| `INFRASTRUCTURE_PERMANENT` | Reservado para `FAILED` (ver §18) | Suporte |

Os dois códigos de saldo são **distintos de propósito** (regra 7.9): uma aposta sem saldo é rotina; uma reversão bloqueada por saldo é incidente.

## 8. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha + UPDATE condicional por versão como defesa em profundidade.**

```
BEGIN
  SET LOCAL lock_timeout = '5s'
  SELECT … FROM wallets WHERE id = $1 FOR UPDATE      -- serializa só esta wallet
  (inbox, idempotência, referência)                     -- leem commits anteriores (READ COMMITTED)
  INSERT wager_transactions …
  UPDATE wallets SET balance=…, version=v+1 WHERE id=$1 AND version=v   -- 0 linhas → conflito
  INSERT wallet_ledger_entries …
  INSERT outbox_messages …
COMMIT                                                  -- triggers deferidos validam saldo == ledger
```

**Por que pessimista e não otimista puro:** no cenário obrigatório (duas apostas de 80 sobre 100) e numa hot wallet, o otimista faz quase toda tentativa concorrente falhar e repetir, e o número de retries cresce com a contenção. Com o lock, as operações da mesma wallet entram em fila no banco e cada uma vê o saldo já atualizado pela anterior: exatamente uma aposta de 80 passa e a outra é rejeitada **por regra de negócio**, não por conflito técnico. Wallets diferentes nunca disputam o mesmo lock (não existe lock global).

**Por que `READ COMMITTED` e não `SERIALIZABLE`:** depois do `FOR UPDATE`, cada statement seguinte enxerga os commits anteriores. É isso que faz a segunda requisição idêntica, que esperou o lock, encontrar a primeira já commitada e responder replay. `SERIALIZABLE` não acrescenta correção aqui e geraria falhas `40001` em massa sob contenção.

**O `UPDATE … AND version = v`** nunca deveria falhar com o lock em vigor. Ele existe para que um bug ou um caminho futuro sem lock vire `ConcurrencyConflictError` (retry), e não lost update.

**Retry local limitado** (`withTransientRetry`): 4 tentativas, backoff exponencial com jitter a partir de 15 ms, para `lock_timeout` (`55P03`), deadlock (`40P01`), serialização (`40001`), conexão e conflito de versão. Uma corrida na `UNIQUE` de idempotência também dispara retry: a nova tentativa encontra a transação vencedora e responde replay ou conflito. Esgotadas as tentativas: HTTP `503` com `Retry-After`; na fila, devolve a mensagem com backoff.

**Análise de deadlock.** A entrada (HTTP/fila) trava *wallet → (insere a transação)*. O worker de referências trava *transação pendente → wallet*. As ordens são diferentes, mas a entrada só toca linhas pendentes por `wakeDependents`, que usa `SKIP LOCKED` e **nunca espera**. Logo, não há ciclo de espera.

**Trade-off assumido:** o throughput de **uma** wallet é serial, limitado pela latência de uma transação curta (alguns milissegundos). Para apostas é aceitável: uma wallet pertence a um jogador, e o paralelismo real vem do número de wallets. Os testes provam 200 operações simultâneas na mesma wallet sem nenhum erro técnico.

## 9. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) ou `data.idempotencyKey` (fila), único por `(provider_id, idempotency_key)` **no banco**. Nada fica em memória.
- **`payloadHash` = `"sha256:" + hex(SHA-256(UTF-8(canonicalJson(campos))))`**, onde:
  - os campos são `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado para 2 casas) e `referenceExternalTransactionId` (omitido se ausente);
  - o JSON canônico tem chaves ordenadas recursivamente, sem espaços e sem `undefined`;
  - header, `messageId`, `occurredAt` e demais metadados de transporte **não** entram.
- **Fluxo:** lock da wallet → `findByIdempotencyKey`:
  - não existe → processa;
  - existe com o mesmo hash → **replay**: devolve o resultado original (status, `failureCode`, `resultBalance`) com `idempotentReplay: true`, sem efeito novo;
  - existe com hash diferente → **`409 IDEMPOTENCY_KEY_CONFLICT`**, nunca replay.
- **Replay devolve o saldo da época**, não o atual. O teste faz um `WIN` entre a aposta e o replay e confirma.
- **Fila:** além da chave, a inbox persiste `(consumer_name, message_id)` na **mesma transação** do efeito financeiro. Redelivery da mesma mensagem → `ON CONFLICT DO NOTHING` → nenhum efeito → ack. A mesma operação republicada com outro `messageId` cai na chave de idempotência.

## 10. Garantias no schema

Toda garantia da seção 6 do desafio vale **no PostgreSQL**, inclusive contra SQL manual. Cada linha abaixo tem um teste de integração que tenta violar a regra direto no banco.

| Invariante | Mecanismo |
| --- | --- |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK` nos saldos do ledger |
| `version` só muda junto com o saldo, de 1 em 1 | trigger `wallet_guard` |
| Identidade da wallet imutável; wallet não é apagada | trigger `wallet_guard` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Ledger append-only | triggers `ledger_no_update_delete` e `ledger_no_truncate` |
| Aritmética do lançamento | `CHECK (after = before ± amount)` por direção |
| Ledger encadeado | trigger `ledger_chain`: `balance_before` = `balance_after` anterior da wallet |
| Um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| **Saldo materializado == ledger** | **constraint triggers `DEFERRABLE INITIALLY DEFERRED`** em `wallets` e no ledger: no `COMMIT`, `wallets.balance` precisa ser igual ao último `balance_after` (ou 0) |
| Reversão única | índice único parcial em `reference_transaction_id` onde `kind IN (REFUND, ROLLBACK) AND status = PROCESSED` |
| Uma `OPENING` por wallet, sempre `PROCESSED` | índice único parcial + `CHECK` |
| `REFUND`/`ROLLBACK` exigem referência; `BET` não tem | `CHECK` |
| `failure_code` ⇔ `REJECTED`/`FAILED`; `processed_at` ⇔ terminal; `PROCESSED` tem `result_balance` | `CHECK` |
| Transação terminal não muda; campos de negócio imutáveis; não é apagada | trigger `wager_tx_guard` |
| Envelope da outbox imutável; publicação não é desfeita | trigger `outbox_guard` |

As FKs são `DEFERRABLE INITIALLY DEFERRED`, então a ordem dos `INSERT`s dentro da transação não importa (wallet, `OPENING` e lançamento nascem juntos). Os triggers lançam SQLSTATE de integridade (`23xxx`), que a aplicação classifica como erro permanente, nunca transitório.

## 11. Consumo de SQS

```
ReceiveMessage (long poll, até 10) ──► agrupa por MessageGroupId (= walletId)
   grupos em paralelo; mensagens do mesmo grupo em sequência
   └─► SubmitWagerTransaction.execute(..., inbox: {consumer, messageId})   ← mesmo use case do HTTP
          sucesso (inclusive REJECTED e replay) ──► COMMIT ──► DeleteMessage (ack)
          erro de negócio                        ──► ack (repetir daria o mesmo resultado)
          erro transitório                       ──► ChangeMessageVisibility(2^n s, teto 60 s)
                                                      5ª entrega falha → redrive move para a DLQ
          erro permanente / mensagem ilegível    ──► SendMessage na DLQ (failureReason) + ack
```

- **Ack só depois do commit.** Se o processo morrer entre o commit e o `DeleteMessage`, a mensagem volta, a inbox a reconhece e nada é aplicado de novo. Esse é o cenário 5 da seção 13, testado com injeção de falha.
- **Classificação** (`classifyError`):
  - negócio: erros de domínio, payload inválido, conflitos de idempotência, wallet inexistente;
  - transitório: `ApplicationError.transient`;
  - permanente: todo o resto.

  Um erro desconhecido vai para a DLQ, onde fica auditável, em vez de ser repetido para sempre.
- **FIFO é otimização, não garantia:** a ordem por grupo reduz `PENDING_REFERENCE`, mas a correção vem do lock e das constraints. Com 3 instâncias, o SQS entrega cada grupo a um consumidor por vez.
- **`SIGTERM`:** o `PollingLoop` aborta o long poll; a mensagem em andamento **termina**; as recebidas e ainda não iniciadas voltam com `VisibilityTimeout = 0`. O Nest chama `beforeApplicationShutdown` (drenagem, com teto de 20 s, abaixo do `stop_grace_period` de 30 s) antes de `onApplicationShutdown` (fecha ORM e SQS), então tudo drena com as conexões abertas.

## 12. Transactional Outbox

Os eventos são gravados em `outbox_messages` **na mesma transação** da mudança financeira. Publicar antes do commit é impossível por construção.

```
1. claim:    UPDATE … SET locked_by, locked_until = now + 30s
             WHERE id IN (SELECT … WHERE published_at IS NULL AND next_attempt_at <= now
                          AND (locked_until IS NULL OR locked_until < now)
                          FOR UPDATE SKIP LOCKED LIMIT 25)            -- transação curta, commitada
2. publish:  SendMessageBatch (FORA de transação SQL; não segura conexão durante I/O)
3. result:   ok    → published_at = now
             falha → attempts++, next_attempt_at = now + min(1s·2^n, 60s)   (sem limite: evento confirmado nunca é descartado)
```

**O cenário obrigatório:** o PostgreSQL confirma o commit e o processo morre antes de publicar. Os eventos ficam na outbox; se o processo tinha reivindicado o lote, o lease expira em 30 s; outra instância os publica; uma eventual publicação duplicada é segura. Testado com lease expirado, com dois publishers concorrentes e com 3 processos.

- **Entrega at-least-once.** `MessageDeduplicationId = eventId` faz o SQS descartar republicações em até 5 minutos (otimização); a garantia é o consumidor deduplicar por `eventId`.
- **Ordem:** `MessageGroupId = aggregateId` mantém a ordem por agregado na fila. Dois publishers podem inverter eventos do mesmo agregado; `WalletBalanceChanged.walletVersion` permite ao consumidor ordenar e descartar versões antigas.

| Evento | Quando | aggregateId |
| --- | --- | --- |
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` | transação |
| `WagerTransactionRejected` | rejeição de negócio (inclusive `REFERENCE_NOT_FOUND` pelo worker) | transação |
| `WalletBalanceChanged` | só quando o saldo muda (inclusive a abertura da wallet) | wallet |
| `WagerTransactionPendingReference` | na **entrada** em espera (não a cada nova verificação) | transação |

## 13. Referências fora de ordem

- Referência ausente → `PENDING_REFERENCE` com `next_reference_check_at`, `202` no HTTP e evento publicado.
- **Política:** 12 verificações no total, backoff de 2 s, 4 s, 8 s… com teto de 5 min (~24 min ao todo). Provedores costumam reentregar a referência em segundos; ~24 minutos cobrem uma indisponibilidade curta do provedor sem deixar a rodada aberta por horas. A política é parâmetro (`REFERENCE_RETRY_POLICY`) e os testes a encurtam.
- **Worker:** cada transação vencida é reavaliada na própria transação SQL (`claim` com `FOR UPDATE SKIP LOCKED` → lock da wallet → `settleAndPersist`). Três instâncias rodando o worker nunca pegam a mesma linha (testado).
- **Atalho:** quando a referência chega, `wakeDependents` antecipa a verificação das dependentes para "agora", então não é preciso esperar o backoff.
- **Esgotado:** `REJECTED / REFERENCE_NOT_FOUND`, com `WagerTransactionRejected` na outbox.

## 14. API HTTP

O mapeamento de status está no `README` e é implementado num único lugar (`HttpErrorFilter` + `statusFor`). Os pontos de projeto:

- As cinco situações que o desafio pede para distinguir têm status diferentes: payload inválido `400`, conflito de idempotência `409`, rejeição de negócio `422`, pendente `202` e falha transitória `503`.
- **Rejeição de negócio é resultado, não erro:** `422` com o mesmo corpo da submissão (`transactionId`, `status: REJECTED`, `failureCode`, `balance`), inclusive em replay.
- Todo erro traz `retryable`. Só `503` é `true`, e vem com `Retry-After`.
- O cursor do ledger é `base64url("v1:<walletId>:<seq>")`, onde `seq` vem de uma coluna `GENERATED ALWAYS AS IDENTITY`. É estável (o ledger é append-only e `seq` nunca é reutilizado), opaco e amarrado à wallet: o cursor de outra wallet recebe `400`.
- **A reconciliação lê saldo e ledger sob o lock da wallet**, para que uma movimentação concorrente não produza divergência falsa. Divergência é logada como erro, contada em `wagering_reconciliations_total{result="mismatch"}` e sinalizada com `consistent: false`; **nunca é corrigida**.

## 15. Observabilidade

**Logs**: JSON por linha (`JsonLogger`, sem dependências).

- Contexto herdado por `child()`: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`, `worker`.
- **Redação por nome de campo**: `payload`, `body`, `amount`, `balance`, `money`, `authorization`, `token`, `secret` e similares viram `[redacted]`. Ids e códigos permanecem; são o que permite diagnosticar sem expor dados financeiros. Há um teste que confirma que o valor apostado não aparece em nenhum log.
- `X-Correlation-Id` é aceito, validado e devolvido; na fila, o correlation id é o `messageId` (ou `correlationId` do envelope).

**Métricas** (`GET /metrics`, registry por instância com label `instance_id`):

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `wagering_transactions_total` | counter | `status`, `kind`, `source` (`http`/`sqs`/`reference-worker`) |
| `wagering_duplicates_detected_total` | counter | `kind` (`idempotency_replay`, `inbox_redelivery`) |
| `wagering_retries_total` | counter | `operation`, `reason` |
| `wagering_lock_conflicts_total` | counter | `reason` (lock timeout, deadlock, conflito de versão) |
| `wagering_dlq_messages_total` | counter | `reason` (`MALFORMED_MESSAGE`, `retries_exhausted`, …) |
| `wagering_processing_duration_seconds` | histogram | `source` |
| `wagering_reconciliations_total` | counter | `result` (`consistent`/`mismatch`) |
| `wagering_outbox_published_total` | counter | — |
| `wagering_outbox_pending` | gauge | — |
| `wagering_outbox_lag_seconds` | gauge | idade do evento pendente mais antigo |

Mais as métricas padrão de processo do `prom-client`.

**Health:** `/health/live` não toca dependências (reiniciar o processo não cura o banco). `/health/ready` verifica PostgreSQL (`SELECT 1`) e SQS (`GetQueueAttributes`) em paralelo, com timeout de 2 s cada e latência no corpo, e responde `503` para sair do balanceador. O Compose usa o `ready` como healthcheck.

## 16. Autenticação

**Decisão: não implementar neste desafio.** Autenticação não pontua (seção 2 do desafio) e competiria em tempo com correção, concorrência e idempotência. O ponto de extensão está no código:

- `ProviderIdentityPort.resolve(authorizationHeader) → ProviderIdentity { providerId, scopes }`;
- `ProviderAuthGuard`, guard global: sem um `ProviderIdentityPort` registrado (o caso atual) ele libera tudo; com um registrado, recusa quando o token não resolve uma identidade;
- `@Public()` em `/health/*` e `/metrics`, que ficam abertos mesmo com a autenticação ativa.

**Desenho que eu adotaria:** um IdP externo (Keycloak) com **client credentials** OIDC, um client por provedor de jogos.

1. O guard valida o bearer token (assinatura via JWKS em cache, `iss`, `aud`, `exp`).
2. O claim do client (`azp`) é mapeado para o `providerId` de domínio.
3. O guard exige `identity.providerId === body.providerId`: um provedor não submete nem consulta transações de outro.
4. Escopos separam submissão (`wagering:write`) de consulta (`wagering:read`) e de operação (`wallets:admin`).

Nada de tabela própria de usuários ou hash de senha. Mensagens da fila são canal interno confiável, mas o `providerId` delas continua sujeito às mesmas validações de domínio (referência do mesmo provider etc.).

## 17. Estratégia de testes

**197 testes, nenhum com PostgreSQL ou SQS mockado.**

| Suíte | Qtde | Escopo |
| --- | --- | --- |
| `tests/unit` | 119 | `Money` (escala, entradas inválidas, conflito de moeda), invariantes da `Wallet`, ledger, máquina de estados, todas as regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, hash e conflito de idempotência, eventos |
| `tests/integration` | 70 | **Schema:** cada constraint e trigger do §10, migrations reversíveis. **Atomicidade:** falha antes do COMMIT não deixa saldo, transação, lançamento, inbox nem outbox. **API:** todos os endpoints e status. **Mensageria:** consumidor, inbox, redelivery, DLQ, retry, shutdown, outbox e worker |
| `tests/concurrency` | 8 | Paralelismo real: 3 instâncias no mesmo processo (pools separados) e 3 **processos** `bun run src/main.ts` |

Cada arquivo cria o próprio banco (`wagering_test_<nome>`), migrado com as migrations de produção, e as próprias filas FIFO no LocalStack. Os testes são isolados entre si e das réplicas do Docker.

**Cenários obrigatórios da seção 13:**

| # | Cenário | Teste |
| --- | --- | --- |
| 1 | Mesma aposta 50× em paralelo → um débito | `concurrency/hot-wallet` |
| 2 | Disputa pelo saldo da mesma wallet (100 − 80 ∥ 80, 25 rodadas) | `concurrency/hot-wallet` |
| 3 | Wallets distintas em paralelo | `concurrency/hot-wallet` |
| 4 | ≥ 3 processos simultâneos (HTTP triplicado + fila duplicada + referências fora de ordem) | `concurrency/multi-instance` |
| 5 | Worker morto depois do commit e antes do ack | `integration/messaging` |
| 6 | Dois publishers na mesma outbox | `integration/messaging` e `integration/schema` |
| 7 | `ROLLBACK`/`REFUND` antes da referência | `integration/messaging`, `integration/http-api` e `concurrency/multi-instance` |
| 8 | Reinício do serviço com consistência final (`SIGKILL` + `SIGTERM` no meio da carga) | `concurrency/multi-instance` |

**Invariante final em todos:** `expectLedgerConsistent` confere `wallet.balance == saldo reconstruído pelo ledger` e `version == número de lançamentos`.

**Determinismo:** políticas de retry e relógio são injetáveis (os testes do worker usam um relógio adiantado e política curta); o backoff de domínio é determinístico, sem jitter. Os testes de concorrência afirmam **resultados**, nunca ordem: "exatamente uma de duas", "exatamente 100 de 200".

## 18. Trade-offs e limitações

**Trade-offs conscientes**

- **Throughput por wallet é serial** (lock pessimista). Escala com o número de wallets, não com a concorrência sobre uma wallet. Ver §8.
- **Triggers no banco** custam alguns microssegundos por escrita e acoplam regras ao PostgreSQL. Em troca, a invariante saldo == ledger vale até para SQL manual, e um bug na aplicação vira erro em vez de dado corrompido.
- **A reconciliação trava a wallet** por alguns milissegundos para ler saldo e ledger de forma consistente. Para varredura em lote, eu leria em `REPEATABLE READ` sem lock.
- **SQL explícito em vez do Unit of Work completo do MikroORM** nas escritas críticas: menos "mágica" do ORM, mais código, mas cada instrução que sustenta uma garantia fica visível.

**Limitações conhecidas**

- **`FAILED` não é produzido por nenhum fluxo atual.** O estado existe no modelo, no schema e na máquina de estados, mas erros permanentes **desfazem** a transação SQL e a mensagem vai para a DLQ (onde fica auditável), em vez de persistir uma transação `FAILED`. Persistir `FAILED` exigiria uma segunda transação, fora da que falhou, para gravar o estado terminal.
- **Wallet inexistente não gera registro nem evento** (não há onde persistir por causa da FK); fica só no log e, no HTTP, na resposta `422`.
- **Retenção:** `inbox_messages` e `outbox_messages` crescem indefinidamente (o `DELETE` da outbox é bloqueado por trigger). Em produção: particionamento por mês + arquivamento, com o trigger liberando `DELETE` de linhas publicadas há mais de N dias.
- **`wagering_lock_conflicts_total` conta conflitos que causaram retry**, não esperas de lock bem-sucedidas. O tempo de espera aparece na latência.
- **O worker de referências usa o id da transação como `correlationId`**, não o correlation id original da requisição (que está persistido em `wager_transactions.correlation_id`, mas não é exposto pelo agregado).
- **Backoffs usam o relógio da instância.** Com relógios dessincronizados, uma instância pode reavaliar uma transação pendente um pouco antes. É seguro (só antecipa uma verificação), mas `now()` do banco seria mais preciso.
- **Sem heartbeat de visibilidade** no consumidor: uma mensagem que demore mais que o `VisibilityTimeout` (30 s) pode ser entregue a outra instância. A inbox e o lock tornam isso seguro, mas desperdiça trabalho. O processamento típico é de milissegundos.
- **Uma única escala (2 casas) para todas as moedas.** Moedas com 0 ou 3 casas decimais exigiriam escala por moeda no `Money` e nas colunas.
- **Sem endpoint de busca de wallet por `playerId`** (não pedido).
- **Teste de carga (diferencial opcional) não foi feito.** Os testes de concorrência exercitam até 450 requisições simultâneas, mas sem a metodologia de medição pedida (p50/p95/p99, throughput, ambiente).

**Próximos passos, em ordem de valor:** persistir `FAILED` numa transação separada; teste de carga com `bun run test:load` (k6 ou autocannon); retenção e particionamento da inbox e da outbox; autenticação com Keycloak conforme §16; OpenTelemetry propagando o `correlationId` da requisição até o evento publicado.
