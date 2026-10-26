import { createHash } from "node:crypto";
import { canonicalJson } from "@/shared/domain/canonical-json";
import { Money, type MoneyProps } from "@/shared/domain/money";

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
