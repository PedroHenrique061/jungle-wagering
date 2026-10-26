import {
  ApplicationError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  UniqueViolationError,
} from "@/wagering/application/errors";
import { DomainError } from "@/shared/domain/domain-error";

/**
 * Traduz erros do driver/ORM para a taxonomia da aplicação, pelo SQLSTATE:
 *
 * | SQLSTATE            | Significado                         | Classe                |
 * | ------------------- | ----------------------------------- | --------------------- |
 * | 23505               | unique_violation                    | UniqueViolationError  |
 * | 23xxx (demais)      | integridade (CHECK, trigger, FK)    | Permanent             |
 * | 40001 / 40P01       | serialização / deadlock             | Transient             |
 * | 55P03 / 57014       | lock_timeout / statement_timeout    | Transient             |
 * | 08xxx / 57P0x / 53x | conexão, shutdown, recursos         | Transient             |
 * | ECONNREFUSED etc.   | rede                                | Transient             |
 */
export function translateDbError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof ApplicationError) return error;

  const sqlState = findSqlState(error);
  const message = error instanceof Error ? error.message : String(error);

  if (sqlState === "23505") return new UniqueViolationError(findConstraint(error), error);
  if (sqlState?.startsWith("23")) return new PermanentInfrastructureError(`Integrity violation: ${message}`, error);
  if (sqlState && isTransientSqlState(sqlState)) return new TransientInfrastructureError(`Database: ${message}`, error);
  if (isNetworkError(error)) return new TransientInfrastructureError(`Database unreachable: ${message}`, error);
  return error;
}

function isTransientSqlState(state: string): boolean {
  return (
    state === "40001" ||
    state === "40P01" ||
    state === "55P03" ||
    state === "57014" ||
    state.startsWith("08") ||
    state.startsWith("57P") ||
    state.startsWith("53")
  );
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

function isNetworkError(error: unknown): boolean {
  for (const e of chain(error)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (e instanceof Error && /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

/** MikroORM envolve o erro do `pg`; o SQLSTATE pode estar em `code`, `sqlState` ou na causa. */
function findSqlState(error: unknown): string | undefined {
  for (const e of chain(error)) {
    const candidate = (e as { sqlState?: unknown; code?: unknown }).sqlState ?? (e as { code?: unknown }).code;
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function findConstraint(error: unknown): string | undefined {
  for (const e of chain(error)) {
    const constraint = (e as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    const match = e instanceof Error ? /constraint "([^"]+)"/.exec(e.message) : null;
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function* chain(error: unknown): Generator<object> {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    yield current;
    current = (current as { cause?: unknown }).cause ?? (current as { previous?: unknown }).previous;
  }
}
