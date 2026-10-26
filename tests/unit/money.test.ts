import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "@/shared/domain/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — validação de entrada", () => {
  test.each(["25.00", "0", "0.5", "1000", "999999999.99"])("aceita %p", (amount) => {
    expect(() => brl(amount)).not.toThrow();
  });

  test.each([
    ["string vazia", ""],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["notação científica", "1e3"],
    ["mais de 2 casas", "1.001"],
    ["negativo", "-1.00"],
    ["sinal positivo explícito", "+1.00"],
    ["zero à esquerda", "01.00"],
    ["ponto sem casas", "1."],
    ["espaços", " 1.00"],
    ["vírgula decimal", "1,00"],
  ])("rejeita %s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount numérico (number nunca é aceito)", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(["brl", "BR", "REAL", "", "B1L"])("rejeita moeda inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money — escala e serialização", () => {
  test("normaliza para 2 casas fixas", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("0.5").amount).toBe("0.50");
  });

  test("não perde precisão onde float perderia (0.1 + 0.2)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("soma de muitos centavos é exata", () => {
    let acc = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) acc = acc.add(brl("0.01"));
    expect(acc.amount).toBe("10.00");
  });

  test("valores grandes sem notação científica", () => {
    expect(brl("999999999999999.99").add(brl("0.01")).amount).toBe("1000000000000000.00");
  });

  test("negate e zero não produzem -0.00", () => {
    expect(Money.zero("BRL").negate().amount).toBe("0.00");
    expect(brl("3.10").negate().amount).toBe("-3.10");
  });

  test("toString legível", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});

describe("Money — aritmética e imutabilidade", () => {
  test("operações retornam nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.amount).toBe("10.00");
    expect(b.amount).toBe("15.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("subtract pode produzir negativo internamente", () => {
    const r = brl("10.00").subtract(brl("25.00"));
    expect(r.isNegative()).toBe(true);
    expect(r.amount).toBe("-15.00");
  });

  test("comparações", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("0").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.0").equals(brl("1.00"))).toBe(true);
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", (m: Money) => m.add(usd)],
    ["subtract", (m: Money) => m.subtract(usd)],
    ["isLessThan", (m: Money) => m.isLessThan(usd)],
  ])("%s entre moedas diferentes lança erro de domínio", (_op, fn) => {
    expect(() => fn(brl("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes é false (não lança)", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});

describe("Money.fromPersistence", () => {
  test("reidrata NUMERIC com sinal", () => {
    expect(Money.fromPersistence("-5.00", "BRL").amount).toBe("-5.00");
  });

  test("rejeita escala maior que 2 vinda do banco", () => {
    expect(() => Money.fromPersistence("1.001", "BRL")).toThrow(InvalidMoneyError);
  });
});
