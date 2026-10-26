/**
 * Erros de aplicação/infraestrutura, classificados para a política de retry:
 *
 * - transient: pode dar certo se repetir (rede, lock timeout, deadlock, serialização, conflito de versão).
 * - permanent: repetir não adianta (violação de integridade inesperada, payload que o banco recusa).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly transient: boolean;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** UPDATE condicional por versão não afetou linhas. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = "CONCURRENCY_CONFLICT";
  readonly transient = true;
  constructor(entity: string, id: string) {
    super(`Concurrent modification of ${entity} ${id}`);
  }
}

export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";
  readonly transient = false;
  constructor(
    public readonly constraint: string | undefined,
    cause?: unknown,
  ) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`, { cause });
  }
}

/** Banco ou fila indisponível, timeout, deadlock, serialização. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE";
  readonly transient = true;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** Violação de integridade inesperada (trigger/CHECK). Bug ou dado corrompido: não adianta repetir. */
export class PermanentInfrastructureError extends ApplicationError {
  readonly code = "PERMANENT_INFRASTRUCTURE";
  readonly transient = false;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

// ---------------------------------------------------------------- erros de requisição/negócio da aplicação

/** Requisição malformada (header ausente, corpo inválido). HTTP 400; na fila: erro de negócio (ack). */
export class InvalidRequestError extends ApplicationError {
  readonly code = "INVALID_REQUEST";
  readonly transient = false;
  constructor(message: string) {
    super(message);
  }
}

/** Mesma Idempotency-Key com payload diferente: conflito, não replay. HTTP 409. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";
  readonly transient = false;
  constructor(
    public readonly providerId: string,
    public readonly idempotencyKey: string,
    public readonly existingTransactionId: string,
  ) {
    super(`Idempotency-Key "${idempotencyKey}" was already used with a different payload`);
  }
}

/** Mesmo (provider, externalTransactionId) já registrado sob outra Idempotency-Key. HTTP 409. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = "EXTERNAL_TRANSACTION_ID_CONFLICT";
  readonly transient = false;
  constructor(
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly existingTransactionId: string,
  ) {
    super(`externalTransactionId "${externalTransactionId}" was already submitted with another Idempotency-Key`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  readonly transient = false;
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = "RESOURCE_NOT_FOUND";
  readonly transient = false;
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

/**
 * Regra de negócio que impede até de registrar a transação (ex.: wallet inexistente — a FK não
 * permitiria persistir). HTTP 422 com failureCode; na fila: erro de negócio (ack).
 */
export class UnprocessableTransactionError extends ApplicationError {
  readonly code = "UNPROCESSABLE_TRANSACTION";
  readonly transient = false;
  constructor(
    public readonly failureCode: string,
    message: string,
  ) {
    super(message);
  }
}
