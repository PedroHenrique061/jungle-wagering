import { Migration } from "@mikro-orm/migrations";

/**
 * Schema base: tabelas, chaves, CHECKs e índices.
 *
 * Decisões:
 * - Dinheiro em NUMERIC(20,2) + coluna de moeda: exato, escala fixa, reidratado como Money.
 * - FKs DEFERRABLE INITIALLY DEFERRED: a ordem dos INSERTs dentro da transação não importa
 *   (wallet, OPENING e lançamento nascem juntos); a integridade é verificada no COMMIT.
 * - Unicidades que sustentam a idempotência estão no banco, nunca só em memória.
 */
export class Migration20261026000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id            uuid           PRIMARY KEY,
        player_id     varchar(128)   NOT NULL,
        currency      char(3)        NOT NULL,
        balance       numeric(20, 2) NOT NULL,
        version       integer        NOT NULL,
        created_at    timestamptz    NOT NULL,
        updated_at    timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       varchar(128)   NOT NULL,
        external_transaction_id           varchar(128)   NOT NULL,
        idempotency_key                   varchar(256)   NOT NULL,
        payload_hash                      varchar(80)    NOT NULL,
        wallet_id                         uuid           NOT NULL,
        player_id                         varchar(128)   NOT NULL,
        round_id                          varchar(128)   NOT NULL,
        game_id                           varchar(128)   NOT NULL,
        kind                              varchar(16)    NOT NULL,
        amount                            numeric(20, 2) NOT NULL,
        currency                          char(3)        NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid,
        status                            varchar(24)    NOT NULL,
        failure_code                      varchar(64),
        result_balance                    numeric(20, 2),
        processed_at                      timestamptz,
        reference_attempts                integer        NOT NULL DEFAULT 0,
        next_reference_check_at           timestamptz,
        correlation_id                    varchar(128),
        created_at                        timestamptz    NOT NULL,
        updated_at                        timestamptz    NOT NULL,

        CONSTRAINT wager_tx_wallet_fk FOREIGN KEY (wallet_id)
          REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT wager_tx_reference_fk FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,

        -- Idempotência: (provider, id externo) e (provider, chave) são únicos.
        CONSTRAINT wager_tx_provider_external_uq    UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),

        CONSTRAINT wager_tx_kind_valid   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_valid CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_tx_reversal_needs_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_bet_has_no_reference
          CHECK (kind <> 'BET' OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_opening_is_processed
          CHECK (kind <> 'OPENING' OR status = 'PROCESSED'),
        -- failureCode existe se e somente se o estado é REJECTED/FAILED.
        CONSTRAINT wager_tx_failure_code_iff_failed
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        -- processedAt existe se e somente se o estado é terminal.
        CONSTRAINT wager_tx_processed_at_iff_terminal
          CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        -- Replay idempotente precisa do saldo observado.
        CONSTRAINT wager_tx_processed_has_result_balance
          CHECK (status <> 'PROCESSED' OR result_balance IS NOT NULL),
        CONSTRAINT wager_tx_result_balance_non_negative
          CHECK (result_balance IS NULL OR result_balance >= 0),
        CONSTRAINT wager_tx_processed_reversal_has_reference_id
          CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_pending_reference_is_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL),
        CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      );
    `);

    // Uma transação só pode ser revertida UMA vez (por REFUND ou ROLLBACK, somados).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    // No máximo uma OPENING por wallet.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_opening_uq
        ON wager_transactions (wallet_id) WHERE kind = 'OPENING';
    `);
    // Worker de referências: só varre o que está esperando.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_ix
        ON wager_transactions (next_reference_check_at) WHERE status = 'PENDING_REFERENCE';
    `);
    // Ao chegar uma transação, encontra quem está esperando por ela.
    this.addSql(`
      CREATE INDEX wager_tx_dependents_ix
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE reference_external_transaction_id IS NOT NULL;
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_ix ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        seq             bigint         GENERATED ALWAYS AS IDENTITY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL,
        direction       varchar(6)     NOT NULL,
        amount          numeric(20, 2) NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL,
        balance_after   numeric(20, 2) NOT NULL,
        created_at      timestamptz    NOT NULL,

        CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id)
          REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id)
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,

        CONSTRAINT ledger_seq_uq                     UNIQUE (seq),
        -- No máximo um lançamento por transação por wallet.
        CONSTRAINT ledger_one_entry_per_tx_wallet_uq UNIQUE (transaction_id, wallet_id),

        CONSTRAINT ledger_direction_valid          CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive          CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative    CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    // Cursor estável e opaco da paginação = seq (monotônico, nunca reutilizado).
    this.addSql(`CREATE INDEX ledger_wallet_seq_ix ON wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(64)  NOT NULL,
        message_id     varchar(256) NOT NULL,
        payload_hash   varchar(80)  NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        transaction_id uuid,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        aggregate_id     varchar(128) NOT NULL,
        event_type       varchar(64)  NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz  NOT NULL,
        published_at     timestamptz,
        locked_by        varchar(128),
        locked_until     timestamptz,
        last_error       varchar(512),
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    // Publisher só varre o que está pendente, em ordem de vencimento.
    this.addSql(`
      CREATE INDEX outbox_pending_due_ix
        ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
