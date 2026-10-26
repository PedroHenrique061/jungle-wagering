export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

export function nextAttemptAt(policy: BackoffPolicy, attempts: number, now: Date): Date {
  const exp = Math.min(attempts, 30);
  const delay = Math.min(policy.baseMs * 2 ** exp, policy.maxDelayMs);
  return new Date(now.getTime() + delay);
}

// 2s, 4s, 8s... com teto de 5 min: 12 verificações cobrem ~24 min
export const REFERENCE_RETRY_POLICY: BackoffPolicy = {
  baseMs: 2_000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 12,
};

export const OUTBOX_RETRY_POLICY: BackoffPolicy = {
  baseMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: Number.POSITIVE_INFINITY,
};
