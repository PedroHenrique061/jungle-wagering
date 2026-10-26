import { createHash } from "node:crypto";
import { canonicalJson } from "@/shared/domain/canonical-json";
import { Money, type MoneyProps } from "@/shared/domain/money";

/** Campos de negócio que entram no hash. Header Idempotency-Key, messageId e metadados de transporte NÃO entram. */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = "sha256:" + hex(SHA-256(UTF-8(canonicalJson(campos))))
 *
 * - `money.amount` é normalizado pela escala do Money ("25" e "25.00" → "25.00"):
 *   são o mesmo valor, portanto o mesmo payload.
 * - `referenceExternalTransactionId` ausente é omitido (não vira null).
 */
export function computeWagerPayloadHash(fields: WagerBusinessFields): string {
  const normalized = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId || undefined,
  };
  const digest = createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
  return `sha256:${digest}`;
}
