import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

/** Contrato de entrada/saída: amount sempre string decimal com 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);

/** Contrato externo: só dígitos, opcionalmente ponto + 1..2 casas. Rejeita sinal, expoente, NaN, Infinity, espaços. */
const INPUT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
/** Persistência (NUMERIC lido como string): aceita sinal, escala <= 2. */
const PERSISTED_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value object monetário imutável.
 *
 * Representação interna: `bigint` em unidades mínimas (centavos, escala fixa 2).
 * Soma/subtração de inteiros é exata — não existe arredondamento possível — e
 * o domínio não depende de nenhuma biblioteca nem de tipos do ORM.
 *
 * - `from` é o único caminho para contratos externos e rejeita negativos.
 * - Negativos só surgem internamente (`negate`, `subtract`, diferença de reconciliação).
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Entrada de contrato externo (API, fila). */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object");
    }
    const { amount, currency } = props;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    const match = INPUT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `amount "${amount}" must be a non-negative decimal with at most ${SCALE} fraction digits`,
      );
    }
    const [, integer, fraction = ""] = match;
    return new Money(Money.toMinor(integer!, fraction, false), Money.assertCurrency(currency));
  }

  /** Reidratação a partir de coluna NUMERIC(…, 2) lida como string. */
  static fromPersistence(amount: string, currency: string): Money {
    const match = typeof amount === "string" ? PERSISTED_PATTERN.exec(amount) : null;
    if (!match) {
      throw new InvalidMoneyError(`persisted amount "${String(amount)}" is not a decimal with scale <= ${SCALE}`);
    }
    const [, sign, integer, fraction = ""] = match;
    return new Money(Money.toMinor(integer!, fraction, sign === "-"), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** String decimal com escala fixa de 2 casas (ex.: "25.00", "-3.10"). */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${integer}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static toMinor(integer: string, fraction: string, negative: boolean): bigint {
    const minor = BigInt(integer) * FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
    return negative ? -minor : minor;
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" must be an ISO-4217 code`);
    }
    return currency;
  }
}
