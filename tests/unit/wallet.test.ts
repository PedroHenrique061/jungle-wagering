import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError } from "@/shared/domain/domain-error";
import { Wallet } from "@/wagering/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "@/wagering/domain/wallet-ledger-entry";
import { InsufficientFundsError, InvalidWalletError, UnbalancedLedgerEntryError } from "@/wagering/domain/errors";
import { PLAYER, T0, WALLET, at, brl, openWallet, usd } from "../support/domain-builders";

describe("Wallet.open", () => {
  test("saldo inicial > 0 gera lançamento CREDIT de abertura; version = 1", () => {
    const { wallet, openingEntry } = Wallet.open({
      playerId: PLAYER,
      initialBalance: brl("1000.00"),
      openingTransactionId: "opening-tx",
      now: T0,
    });
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
    expect(openingEntry?.transactionId).toBe("opening-tx");
  });

  test("saldo inicial zero não gera lançamento", () => {
    const { wallet, openingEntry } = Wallet.open({ playerId: PLAYER, initialBalance: brl("0"), now: T0 });
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("exige openingTransactionId quando há saldo inicial", () => {
    expect(() => Wallet.open({ playerId: PLAYER, initialBalance: brl("1.00"), now: T0 })).toThrow(InvalidWalletError);
  });

  test("moeda da wallet vem do saldo inicial", () => {
    expect(openWallet("10.00", "USD").currency).toBe("USD");
  });
});

describe("Wallet — débito e crédito", () => {
  test("débito reduz saldo, devolve lançamento consistente e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({ transactionId: "t1", money: brl("80.00"), at: at(1) });
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(at(1));
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("débito exatamente igual ao saldo é permitido (saldo zero)", () => {
    const wallet = openWallet("80.00");
    wallet.debit({ transactionId: "t1", money: brl("80.00"), at: at(1) });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("débito maior que o saldo lança e NÃO altera saldo nem version", () => {
    const wallet = openWallet("100.00");
    wallet.debit({ transactionId: "t1", money: brl("80.00"), at: at(1) });
    expect(() => wallet.debit({ transactionId: "t2", money: brl("80.00"), at: at(2) })).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("crédito aumenta saldo e version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit({ transactionId: "t1", money: brl("50.50"), at: at(1) });
    expect(wallet.balance.amount).toBe("150.50");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("operação em outra moeda lança erro de domínio e não altera estado", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.debit({ transactionId: "t1", money: usd("1.00"), at: at(1) })).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit({ transactionId: "t1", money: usd("1.00"), at: at(1) })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimento de valor zero é rejeitado (ledger só aceita valor positivo)", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit({ transactionId: "t1", money: brl("0"), at: at(1) })).toThrow(UnbalancedLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test("saldo == soma dos lançamentos após uma sequência de movimentos", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl("100.00"),
      openingTransactionId: "o",
      now: T0,
    });
    const entries: WalletLedgerEntry[] = [openingEntry!];
    entries.push(wallet.debit({ transactionId: "a", money: brl("33.33"), at: at(1) }));
    entries.push(wallet.credit({ transactionId: "b", money: brl("10.01"), at: at(2) }));
    entries.push(wallet.debit({ transactionId: "c", money: brl("76.68"), at: at(3) }));
    const reconstructed = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.version).toBe(4);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    walletId: WALLET,
    transactionId: "t1",
    createdAt: T0,
  };

  test("factory rejeita aritmética inconsistente", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("91.00"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("factory rejeita saldo resultante negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: brl("5.00").subtract(brl("10.00")),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("é estruturalmente imutável", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("10.00"),
      balanceBefore: brl("0"),
      balanceAfter: brl("10.00"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "DEBIT";
    }).toThrow();
  });
});
