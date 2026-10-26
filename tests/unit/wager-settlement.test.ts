import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { FailureCode } from "@/wagering/domain/failure-code";
import { InvalidTransactionStateError } from "@/wagering/domain/errors";
import { REFERENCE_RETRY_POLICY } from "@/wagering/domain/retry-policy";
import { WagerSettlement, type SettlementContext } from "@/wagering/domain/wager-settlement";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "@/wagering/domain/wager-transaction";
import { LedgerDirection } from "@/wagering/domain/wallet-ledger-entry";
import type { Wallet } from "@/wagering/domain/wallet";
import { at, openWallet, tx } from "../support/domain-builders";

const K = WagerTransactionKind;
const S = WagerTransactionStatus;

function settle(ctx: Partial<SettlementContext> & Pick<SettlementContext, "transaction" | "wallet">) {
  return WagerSettlement.settle({ referenceAlreadyReversed: false, now: at(10), ...ctx });
}

/** Processa uma transação sem referência e devolve-a já PROCESSED. */
function processed(wallet: Wallet, t: WagerTransaction): WagerTransaction {
  const outcome = settle({ transaction: t, wallet });
  expect(outcome.type).toBe("PROCESSED");
  return t;
}

describe("BET", () => {
  test("debita e gera 1 lançamento DEBIT; resultado guarda saldo observado", () => {
    const wallet = openWallet("100.00");
    const bet = tx({ kind: K.Bet, amount: "25.00" });
    const outcome = settle({ transaction: bet, wallet });
    expect(outcome.type).toBe("PROCESSED");
    if (outcome.type !== "PROCESSED") return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("75.00");
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultBalance?.amount).toBe("75.00");
  });

  test("saldo insuficiente → REJECTED/INSUFFICIENT_FUNDS, sem ledger e sem mudar version", () => {
    const wallet = openWallet("10.00");
    const bet = tx({ kind: K.Bet, amount: "25.00" });
    const outcome = settle({ transaction: bet, wallet });
    expect(outcome).toEqual({ type: "REJECTED", failureCode: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe("10.00");
    expect(wallet.version).toBe(1);
    expect(bet.resultBalance?.amount).toBe("10.00");
  });

  test("cenário obrigatório em sequência: 100 − 80 − 80 → uma PROCESSED, uma REJECTED, saldo 20", () => {
    const wallet = openWallet("100.00");
    const first = tx({ amount: "80.00" });
    const second = tx({ amount: "80.00" });
    settle({ transaction: first, wallet });
    settle({ transaction: second, wallet });
    expect([first.status, second.status]).toEqual([S.Processed, S.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("WIN", () => {
  test("credita sem referência", () => {
    const wallet = openWallet("100.00");
    const outcome = settle({ transaction: tx({ kind: K.Win, amount: "50.00" }), wallet });
    expect(outcome.type).toBe("PROCESSED");
    expect(wallet.balance.amount).toBe("150.00");
  });

  test("com referência à BET da mesma rodada registra referenceTransactionId", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ kind: K.Bet, externalTransactionId: "bet-1" }));
    const win = tx({ kind: K.Win, amount: "60.00", reference: "bet-1" });
    settle({ transaction: win, wallet, reference: bet });
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("WIN não pode referenciar outra WIN", () => {
    const wallet = openWallet("100.00");
    const otherWin = processed(wallet, tx({ kind: K.Win, externalTransactionId: "w-1" }));
    const win = tx({ kind: K.Win, reference: "w-1" });
    expect(settle({ transaction: win, wallet, reference: otherWin })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("LOSS", () => {
  test("registra sem mover saldo e sem ledger; version inalterada", () => {
    const wallet = openWallet("100.00");
    const loss = tx({ kind: K.Loss, amount: "25.00" });
    const outcome = settle({ transaction: loss, wallet });
    expect(outcome).toEqual({ type: "PROCESSED" });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(loss.resultBalance?.amount).toBe("100.00");
  });
});

describe("REFUND", () => {
  test("reverte BET PROCESSED com crédito do mesmo valor", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00" }));
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-1" });
    const outcome = settle({ transaction: refund, wallet, reference: bet });
    expect(outcome.type).toBe("PROCESSED");
    expect(wallet.balance.amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test("só referencia BET", () => {
    const wallet = openWallet("100.00");
    const win = processed(wallet, tx({ kind: K.Win, externalTransactionId: "win-1", amount: "30.00" }));
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "win-1" });
    expect(settle({ transaction: refund, wallet, reference: win })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("valor diferente da referência → REVERSAL_AMOUNT_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00" }));
    const refund = tx({ kind: K.Refund, amount: "10.00", reference: "bet-1" });
    expect(settle({ transaction: refund, wallet, reference: bet })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReversalAmountMismatch,
    });
    expect(wallet.balance.amount).toBe("70.00");
  });

  test("referência já revertida → REFERENCE_ALREADY_REVERSED (reversão única)", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00" }));
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-1" });
    expect(settle({ transaction: refund, wallet, reference: bet, referenceAlreadyReversed: true })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.amount).toBe("70.00");
  });

  test("referência REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const wallet = openWallet("10.00");
    const bet = tx({ externalTransactionId: "bet-1", amount: "30.00" });
    settle({ transaction: bet, wallet }); // rejeitada por saldo
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-1" });
    expect(settle({ transaction: refund, wallet, reference: bet })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.amount).toBe("10.00");
  });

  test.each([
    ["rodada", { roundId: "outra-rodada" }],
    ["player", { playerId: "outro-player" }],
    ["provider", { providerId: "provider-b" }],
  ])("referência de outra %s → REFERENCE_MISMATCH", (_label, patch) => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00" }));
    // A reversão vem de outro escopo; a wallet é carregada pela walletId do payload.
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-1", ...patch });
    const outcome = settle({ transaction: refund, wallet, reference: bet });
    expect(outcome.type).toBe("REJECTED");
    if (outcome.type === "REJECTED") {
      expect([FailureCode.ReferenceMismatch, FailureCode.WalletPlayerMismatch]).toContain(outcome.failureCode);
    }
  });

  test("referência de outra rodada (mesmo player/wallet) → REFERENCE_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00", roundId: "r1" }));
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-1", roundId: "r2" });
    expect(settle({ transaction: refund, wallet, reference: bet })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceMismatch,
    });
  });
});

describe("ROLLBACK", () => {
  test("de BET → crédito", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "40.00" }));
    const rollback = tx({ kind: K.Rollback, amount: "40.00", reference: "bet-1" });
    const outcome = settle({ transaction: rollback, wallet, reference: bet });
    expect(outcome.type === "PROCESSED" && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de WIN → débito", () => {
    const wallet = openWallet("100.00");
    const win = processed(wallet, tx({ kind: K.Win, externalTransactionId: "win-1", amount: "40.00" }));
    const rollback = tx({ kind: K.Rollback, amount: "40.00", reference: "win-1" });
    const outcome = settle({ transaction: rollback, wallet, reference: win });
    expect(outcome.type === "PROCESSED" && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de REFUND → débito", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "40.00" }));
    const refund = tx({ kind: K.Refund, externalTransactionId: "ref-1", amount: "40.00", reference: "bet-1" });
    settle({ transaction: refund, wallet, reference: bet });
    const rollback = tx({ kind: K.Rollback, amount: "40.00", reference: "ref-1" });
    settle({ transaction: rollback, wallet, reference: refund });
    expect(rollback.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("ROLLBACK de WIN que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)", () => {
    const wallet = openWallet("0.00");
    const win = processed(wallet, tx({ kind: K.Win, externalTransactionId: "win-1", amount: "50.00" }));
    processed(wallet, tx({ kind: K.Bet, amount: "45.00" })); // jogador gastou o prêmio
    const rollback = tx({ kind: K.Rollback, amount: "50.00", reference: "win-1" });
    const outcome = settle({ transaction: rollback, wallet, reference: win });
    expect(outcome).toEqual({ type: "REJECTED", failureCode: FailureCode.ReversalInsufficientFunds });
    expect(rollback.status).toBe(S.Rejected);
    expect(wallet.balance.amount).toBe("5.00");
  });

  test("não pode referenciar LOSS", () => {
    const wallet = openWallet("100.00");
    const loss = processed(wallet, tx({ kind: K.Loss, externalTransactionId: "loss-1", amount: "10.00" }));
    const rollback = tx({ kind: K.Rollback, amount: "10.00", reference: "loss-1" });
    expect(settle({ transaction: rollback, wallet, reference: loss })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("Referências fora de ordem", () => {
  test("referência ausente → PENDING_REFERENCE, sem tocar saldo", () => {
    const wallet = openWallet("100.00");
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "bet-que-ainda-nao-chegou" });
    const outcome = settle({ transaction: refund, wallet });
    expect(outcome.type).toBe("PENDING_REFERENCE");
    expect(refund.status).toBe(S.PendingReference);
    expect(wallet.version).toBe(1);
  });

  test("referência chega depois → reprocessamento aplica normalmente", () => {
    const wallet = openWallet("100.00");
    const rollback = tx({ kind: K.Rollback, amount: "30.00", reference: "bet-1" });
    settle({ transaction: rollback, wallet, now: at(1) });
    const bet = processed(wallet, tx({ externalTransactionId: "bet-1", amount: "30.00" }));
    const outcome = settle({ transaction: rollback, wallet, reference: bet, now: at(5) });
    expect(outcome.type).toBe("PROCESSED");
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("referência ainda PENDING_REFERENCE mantém a dependente aguardando", () => {
    const wallet = openWallet("100.00");
    const win = tx({ kind: K.Win, externalTransactionId: "win-1", amount: "10.00", reference: "bet-x" });
    settle({ transaction: win, wallet });
    const rollback = tx({ kind: K.Rollback, amount: "10.00", reference: "win-1" });
    expect(settle({ transaction: rollback, wallet, reference: win }).type).toBe("PENDING_REFERENCE");
  });

  test("esgotadas as tentativas → REJECTED/REFERENCE_NOT_FOUND", () => {
    const wallet = openWallet("100.00");
    const refund = tx({ kind: K.Refund, amount: "30.00", reference: "nunca-chega" });
    let outcome = settle({ transaction: refund, wallet });
    let checks = 1;
    while (outcome.type === "PENDING_REFERENCE") {
      outcome = settle({ transaction: refund, wallet });
      checks++;
    }
    expect(outcome).toEqual({ type: "REJECTED", failureCode: FailureCode.ReferenceNotFound });
    expect(checks).toBe(REFERENCE_RETRY_POLICY.maxAttempts);
    expect(wallet.version).toBe(1);
  });
});

describe("Pré-condições", () => {
  test("moeda da transação ≠ moeda da wallet → REJECTED/CURRENCY_MISMATCH", () => {
    const wallet = openWallet("100.00", "BRL");
    expect(settle({ transaction: tx({ currency: "USD" }), wallet })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(wallet.version).toBe(1);
  });

  test("player diferente do dono da wallet → WALLET_PLAYER_MISMATCH", () => {
    const wallet = openWallet("100.00");
    expect(settle({ transaction: tx({ playerId: "intruso" }), wallet })).toEqual({
      type: "REJECTED",
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test("liquidar transação terminal é erro de programação", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, tx());
    expect(() => settle({ transaction: bet, wallet })).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.amount).toBe("75.00");
  });

  test("invariante: saldo final == soma do ledger em fluxo misto", () => {
    const wallet = openWallet("0.00");
    let ledgerSum = Money.zero("BRL");
    const apply = (t: WagerTransaction, reference?: WagerTransaction) => {
      const o = settle({ transaction: t, wallet, reference });
      if (o.type === "PROCESSED" && o.ledgerEntry) ledgerSum = ledgerSum.add(o.ledgerEntry.signedAmount());
      return t;
    };
    apply(tx({ kind: K.Win, externalTransactionId: "w0", amount: "200.00" }));
    const b1 = apply(tx({ externalTransactionId: "b1", amount: "50.00" }));
    apply(tx({ kind: K.Win, externalTransactionId: "w1", amount: "120.00", reference: "b1" }), b1);
    const b2 = apply(tx({ externalTransactionId: "b2", amount: "70.00" }));
    apply(tx({ kind: K.Loss, amount: "70.00", reference: "b2" }), b2);
    const b3 = apply(tx({ externalTransactionId: "b3", amount: "33.33" }));
    apply(tx({ kind: K.Refund, amount: "33.33", reference: "b3" }), b3);
    apply(tx({ amount: "9999.00" })); // rejeitada
    expect(ledgerSum.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("200.00");
  });
});
