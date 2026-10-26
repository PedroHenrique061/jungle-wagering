export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly transient: boolean;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

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

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE";
  readonly transient = true;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class PermanentInfrastructureError extends ApplicationError {
  readonly code = "PERMANENT_INFRASTRUCTURE";
  readonly transient = false;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = "INVALID_REQUEST";
  readonly transient = false;
  constructor(message: string) {
    super(message);
  }
}

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
