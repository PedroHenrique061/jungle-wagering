import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { FailureCode } from "@/wagering/domain/failure-code";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "@/wagering/domain/errors";
import { LedgerDirection } from "@/wagering/domain/wallet-ledger-entry";
import { REFERENCE_RETRY_POLICY } from "@/wagering/domain/retry-policy";
import { computeWagerPayloadHash, type WagerBusinessFields } from "@/wagering/domain/wager-payload-hash";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "@/wagering/domain/wager-transaction";
import { T0, at, brl, tx } from "../support/domain-builders";

const K = WagerTransactionKind;

describe("WagerTransaction.create — validação", () => {
  test("nasce PENDING", () => {
    expect(tx().status).toBe(WagerTransactionStatus.Pending);
  });

  test("OPENING não pode ser submetido", () => {
    expect(() => tx({ kind: K.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("kind desconhecido é rejeitado", () => {
    expect(() => tx({ kind: "JACKPOT" })).toThrow(InvalidWagerTransactionError);
  });

  test.each([K.Refund, K.Rollback])("%s exige referenceExternalTransactionId", (kind) => {
    expect(() => tx({ kind })).toThrow(InvalidWagerTransactionError);
    expect(() => tx({ kind, reference: "bet-1" })).not.toThrow();
  });

  test("BET não pode ter referência", () => {
    expect(() => tx({ kind: K.Bet, reference: "x" })).toThrow(InvalidWagerTransactionError);
  });

  test("transação não pode referenciar a si mesma", () => {
    expect(() => tx({ kind: K.Refund, externalTransactionId: "a", reference: "a" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(() => tx({ kind: K.Loss, amount: "0.00" })).not.toThrow();
    expect(() => tx({ kind: K.Bet, amount: "0.00" })).toThrow(InvalidWagerTransactionError);
    expect(() => tx({ kind: K.Win, amount: "0.00" })).toThrow(InvalidWagerTransactionError);
  });

  test("identificadores vazios são rejeitados", () => {
    expect(() => tx({ providerId: " " })).toThrow(InvalidWagerTransactionError);
    expect(() => tx({ roundId: "" })).toThrow(InvalidWagerTransactionError);
  });
});

describe("WagerTransaction — máquina de estados", () => {
  test("PENDING → PROCESSED guarda referência, data e saldo observado", () => {
    const t = tx();
    t.markProcessed("ref-id", at(1), brl("75.00"));
    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.referenceTransactionId).toBe("ref-id");
    expect(t.processedAt).toEqual(at(1));
    expect(t.resultBalance?.amount).toBe("75.00");
  });

  test.each([
    ["PROCESSED", (t: WagerTransaction) => t.markProcessed(undefined, at(1), brl("1"))],
    ["REJECTED", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at(1))],
    ["FAILED", (t: WagerTransaction) => t.fail(FailureCode.InfrastructurePermanent, at(1))],
  ])("%s é terminal: qualquer transição posterior lança InvalidTransactionStateError", (_s, toTerminal) => {
    const t = tx({ kind: K.Refund, reference: "bet" });
    toTerminal(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, at(2), brl("1"))).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.ReferenceMismatch, at(2))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InfrastructurePermanent, at(2))).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(at(2))).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE agenda com backoff e conta verificações feitas", () => {
    const t = tx({ kind: K.Refund, reference: "bet" });
    t.markPendingReference(T0);
    expect(t.status).toBe(WagerTransactionStatus.PendingReference);
    expect(t.referenceAttempts).toBe(1);
    expect(t.nextReferenceCheckAt).toEqual(at(2)); // base 2s

    t.markPendingReference(at(2));
    expect(t.referenceAttempts).toBe(2);
    expect(t.nextReferenceCheckAt).toEqual(at(2 + 4)); // 2s * 2^1

    t.markPendingReference(at(6));
    expect(t.nextReferenceCheckAt).toEqual(at(6 + 8));
  });

  test("backoff respeita o teto e esgota após maxAttempts verificações", () => {
    const t = tx({ kind: K.Rollback, reference: "bet" });
    t.markPendingReference(T0);
    for (let i = 1; i < REFERENCE_RETRY_POLICY.maxAttempts - 1; i++) {
      expect(t.hasExhaustedReferenceRetries()).toBe(false);
      t.markPendingReference(T0);
    }
    expect(t.hasExhaustedReferenceRetries()).toBe(true);
    const delay = t.nextReferenceCheckAt!.getTime() - T0.getTime();
    expect(delay).toBe(REFERENCE_RETRY_POLICY.maxDelayMs);
  });
});

describe("WagerTransaction — consultas de domínio", () => {
  test("affectsBalance é false apenas para LOSS", () => {
    expect(tx({ kind: K.Loss }).affectsBalance()).toBe(false);
    expect(tx({ kind: K.Bet }).affectsBalance()).toBe(true);
    expect(tx({ kind: K.Win }).affectsBalance()).toBe(true);
  });

  test("direções do ledger por kind", () => {
    const bet = tx({ kind: K.Bet });
    const win = tx({ kind: K.Win });
    const refund = tx({ kind: K.Refund, reference: "b" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da referência", () => {
    const rollback = tx({ kind: K.Rollback, reference: "x" });
    expect(rollback.ledgerDirectionFor(tx({ kind: K.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(tx({ kind: K.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(tx({ kind: K.Refund, reference: "b" }))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS não tem direção", () => {
    expect(() => tx({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("OPENING nasce PROCESSED com crédito", () => {
    const opening = WagerTransaction.opening({ walletId: "w", playerId: "p", money: brl("10.00"), at: T0 });
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.kind).toBe(K.Opening);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("Idempotência — payloadHash", () => {
  const fields: WagerBusinessFields = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "p",
    walletId: "w",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("hash é independente da ordem das chaves", () => {
    const shuffled = Object.fromEntries(Object.entries(fields).reverse()) as unknown as WagerBusinessFields;
    expect(computeWagerPayloadHash(shuffled)).toBe(computeWagerPayloadHash(fields));
  });

  test("valor equivalente com escala diferente gera o mesmo hash", () => {
    expect(computeWagerPayloadHash({ ...fields, money: { amount: "25", currency: "BRL" } })).toBe(
      computeWagerPayloadHash(fields),
    );
  });

  test("mesma idempotency key com payload divergente NÃO casa (conflito, não replay)", () => {
    const original = tx({ externalTransactionId: "transaction-123", amount: "25.00" });
    const resent = tx({ externalTransactionId: "transaction-123", amount: "25.00" });
    const tampered = tx({ externalTransactionId: "transaction-123", amount: "26.00" });
    expect(tampered.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(tampered.payloadHash)).toBe(false);
    expect(original.matchesPayload(resent.payloadHash)).toBe(true);
  });

  test.each([
    ["kind", { kind: "WIN" }],
    ["roundId", { roundId: "round-988" }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["referência", { referenceExternalTransactionId: "bet-1" }],
  ])("mudar %s muda o hash", (_f, patch) => {
    expect(computeWagerPayloadHash({ ...fields, ...patch })).not.toBe(computeWagerPayloadHash(fields));
  });

  test("formato documentado sha256:<hex>", () => {
    expect(computeWagerPayloadHash(fields)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("money inválido no payload é rejeitado antes de hashear", () => {
    expect(() => computeWagerPayloadHash({ ...fields, money: { amount: "1e2", currency: "BRL" } })).toThrow();
    expect(Money.from({ amount: "1", currency: "BRL" }).amount).toBe("1.00");
  });
});
