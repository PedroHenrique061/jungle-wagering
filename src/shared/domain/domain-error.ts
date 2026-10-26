/**
 * Erro de domínio: violação de regra de negócio ou de invariante.
 * `code` é estável e legível por máquina (vai para failureCode / respostas HTTP).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class NegativeMoneyResultError extends DomainError {
  readonly code = "NEGATIVE_MONEY_RESULT";
  constructor() {
    super("Operation would produce a negative amount");
  }
}
