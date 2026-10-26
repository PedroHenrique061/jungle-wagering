import { ApplicationError, UniqueViolationError } from "./errors";
import type { WageringMetrics } from "./metrics";

export interface TransientRetryOptions {
  operation: string;
  maxAttempts: number;
  baseDelayMs: number;
  metrics: WageringMetrics;
  retryOn?: (error: unknown) => boolean;
}

export async function withTransientRetry<T>(fn: () => Promise<T>, options: TransientRetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (error) {
      const retryable = isTransient(error) || options.retryOn?.(error) === true;
      if (!retryable || attempt >= options.maxAttempts) throw error;

      const reason = error instanceof ApplicationError ? error.code : "unknown";
      options.metrics.retry(options.operation, reason);
      if (error instanceof ApplicationError && error.transient) options.metrics.lockConflict(reason);

      const delay = options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay / 2 + Math.random() * delay);
    }
  }
}

export function isTransient(error: unknown): boolean {
  return error instanceof ApplicationError && error.transient;
}

export const isUniqueViolation = (error: unknown): boolean => error instanceof UniqueViolationError;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
