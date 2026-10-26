import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@/shared/domain/canonical-json";
import { uuidv7 } from "@/shared/domain/uuid";
import { InboxMessage } from "@/wagering/domain/inbox-message";
import { OutboxMessage } from "@/wagering/domain/outbox-message";
import { OUTBOX_RETRY_POLICY } from "@/wagering/domain/retry-policy";
import { WagerSettlement } from "@/wagering/domain/wager-settlement";
import { FailureCode } from "@/wagering/domain/failure-code";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "@/wagering/domain/events/wagering-events";
import { T0, at, openWallet, tx } from "../support/domain-builders";
import { WagerTransactionKind } from "@/wagering/domain/wager-transaction";

const ctx = { correlationId: "corr-1", causationId: "msg-123", occurredAt: at(1) };

describe("Integration events", () => {
  test("WalletBalanceChanged carrega MoneyProps e walletVersion; tipo e versão vêm da classe", () => {
    const wallet = openWallet("100.00");
    const bet = tx({ amount: "25.00" });
    const outcome = WagerSettlement.settle({ transaction: bet, wallet, referenceAlreadyReversed: false, now: at(1) });
    if (outcome.type !== "PROCESSED" || !outcome.ledgerEntry) throw new Error("expected processed");

    const event = WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx);
    const json = event.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.occurredAt).toBe(at(1).toISOString());
    expect(json.causationId).toBe("msg-123");
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: bet.id,
      direction: "DEBIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("Processed/Rejected/PendingReference serializam para JSON puro", () => {
    const wallet = openWallet("10.00");
    const ok = tx({ kind: WagerTransactionKind.Loss, amount: "5.00" });
    WagerSettlement.settle({ transaction: ok, wallet, referenceAlreadyReversed: false, now: at(1) });
    const ko = tx({ amount: "50.00" });
    WagerSettlement.settle({ transaction: ko, wallet, referenceAlreadyReversed: false, now: at(1) });
    const pend = tx({ kind: WagerTransactionKind.Refund, reference: "x" });
    WagerSettlement.settle({ transaction: pend, wallet, referenceAlreadyReversed: false, now: at(1) });

    const processed = WagerTransactionProcessed.from(ok, ctx).toJSON();
    const rejected = WagerTransactionRejected.from(ko, ctx).toJSON();
    const pending = WagerTransactionPendingReference.from(pend, ctx).toJSON();

    expect(processed.data.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect(rejected.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(pending.data.referenceExternalTransactionId).toBe("x");
    for (const envelope of [processed, rejected, pending]) {
      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    }
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const wallet = openWallet("100.00");
    const bet = tx();
    WagerSettlement.settle({ transaction: bet, wallet, referenceAlreadyReversed: false, now: at(1) });
    return WagerTransactionProcessed.from(bet, { ...ctx, eventId: "evt-1" });
  };

  test("enqueue usa eventId como id e guarda o envelope como payload", () => {
    const msg = OutboxMessage.enqueue(event());
    expect(msg.id).toBe("evt-1");
    expect(msg.eventType).toBe("WagerTransactionProcessed");
    expect(msg.payload["eventId"]).toBe("evt-1");
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at(1))).toBe(true);
    expect(msg.attempts).toBe(0);
  });

  test("scheduleRetry aplica backoff exponencial com teto", () => {
    const msg = OutboxMessage.enqueue(event());
    msg.scheduleRetry(T0);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(at(1));
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.isDue(at(1))).toBe(true);
    msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt).toEqual(at(2));
    for (let i = 0; i < 20; i++) msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt!.getTime() - T0.getTime()).toBe(OUTBOX_RETRY_POLICY.maxDelayMs);
  });

  test("markPublished é idempotente e tira da fila", () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(2));
    msg.markPublished(at(9));
    expect(msg.publishedAt).toEqual(at(2));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(100))).toBe(false);
  });

  test("lagMs mede atraso desde a ocorrência", () => {
    const msg = OutboxMessage.enqueue(event());
    expect(msg.lagMs(at(4))).toBe(3000);
  });
});

describe("InboxMessage", () => {
  test("receive → markProcessed (idempotente)", () => {
    const inbox = InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-consumer", payloadHash: "h", receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at(1));
    inbox.markProcessed(at(2));
    expect(inbox.processedAt).toEqual(at(1));
  });

  test("exige messageId e consumerName", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", receivedAt: T0 })).toThrow();
  });
});

describe("Utilitários", () => {
  test("canonicalJson ordena chaves recursivamente e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  test("uuidv7 tem versão 7 e é ordenável pelo tempo", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
