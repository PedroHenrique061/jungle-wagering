/**
 * Backoff exponencial determinístico (sem jitter, para testes reproduzíveis;
 * o espalhamento entre instâncias vem do SKIP LOCKED e do relógio de cada linha).
 *
 * delay(n) = min(baseMs * 2^n, maxDelayMs), n = tentativas já feitas.
 */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

export function nextAttemptAt(policy: BackoffPolicy, attempts: number, now: Date): Date {
  const exp = Math.min(attempts, 30); // evita overflow de 2^n
  const delay = Math.min(policy.baseMs * 2 ** exp, policy.maxDelayMs);
  return new Date(now.getTime() + delay);
}

/**
 * PENDING_REFERENCE: 2s, 4s, 8s … teto de 5 min, 12 tentativas ≈ 25 min no total.
 * Justificativa: provedores costumam reentregar a referência em segundos; 25 min
 * cobre indisponibilidades curtas do provedor sem deixar a rodada aberta por horas.
 */
export const REFERENCE_RETRY_POLICY: BackoffPolicy = {
  baseMs: 2_000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 12,
};

/** Outbox: 1s, 2s, 4s … teto de 1 min. Sem limite de tentativas: evento confirmado nunca é descartado. */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = {
  baseMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: Number.POSITIVE_INFINITY,
};
