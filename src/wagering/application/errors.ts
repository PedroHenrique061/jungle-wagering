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
