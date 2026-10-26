import { Migration } from "@mikro-orm/migrations";

export class Migration20261026000002_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% rejected)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
    `);

    this.addSql(`
      CREATE FUNCTION ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric(20, 2);
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS NOT NULL AND wallet_currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_after INTO previous_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY seq DESC
         LIMIT 1;

        IF NEW.balance_before <> COALESCE(previous_after, 0) THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            NEW.wallet_id, NEW.balance_before, COALESCE(previous_after, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_check();
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_consistency_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target_wallet uuid;
        stored        numeric(20, 2);
        last_after    numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet := NEW.id;
        ELSE
          target_wallet := NEW.wallet_id;
        END IF;

        SELECT balance INTO stored FROM wallets WHERE id = target_wallet;
        SELECT balance_after INTO last_after
          FROM wallet_ledger_entries
         WHERE wallet_id = target_wallet
         ORDER BY seq DESC
         LIMIT 1;

        IF stored IS DISTINCT FROM COALESCE(last_after, 0) THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger %', target_wallet, stored, COALESCE(last_after, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_match_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_consistency_check();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_wallet
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_consistency_check();
    `);

    this.addSql(`
      CREATE FUNCTION wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % version must increment by 1 when balance changes', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version must not change without a balance change', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_guard
        BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_guard();
    `);

    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager_transaction % business fields are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();
    `);

    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'outbox_messages cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % envelope is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox message % was already published', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_guard
        BEFORE UPDATE OR DELETE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS outbox_guard ON outbox_messages;`);
    this.addSql(`DROP FUNCTION IF EXISTS outbox_guard();`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_tx_guard ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard();`);
    this.addSql(`DROP TRIGGER IF EXISTS wallet_guard ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_guard();`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_matches_wallet ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallets_match_ledger ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_consistency_check();`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_chain ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_chain_check();`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_update_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only();`);
  }
}
