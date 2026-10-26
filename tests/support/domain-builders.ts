import { Money } from "@/shared/domain/money";
import { Wallet } from "@/wagering/domain/wallet";
import { WagerTransaction, WagerTransactionKind } from "@/wagering/domain/wager-transaction";
import { computeWagerPayloadHash } from "@/wagering/domain/wager-payload-hash";

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const at = (secondsAfterT0: number) => new Date(T0.getTime() + secondsAfterT0 * 1000);

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";

export function openWallet(amount = "100.00", currency = "BRL"): Wallet {
  return Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: Money.from({ amount, currency }),
    openingTransactionId: "opening-tx",
    now: T0,
  }).wallet;
}

let seq = 0;

export interface TxOverrides {
  kind?: WagerTransactionKind | string;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  reference?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  createdAt?: Date;
}

export function tx(o: TxOverrides = {}): WagerTransaction {
  const providerId = o.providerId ?? "provider-a";
  const externalTransactionId = o.externalTransactionId ?? `ext-${++seq}`;
  const money = { amount: o.amount ?? "25.00", currency: o.currency ?? "BRL" };
  const fields = {
    providerId,
    externalTransactionId,
    playerId: o.playerId ?? PLAYER,
    walletId: o.walletId ?? WALLET,
    roundId: o.roundId ?? "round-987",
    gameId: "fortune-chimp",
    kind: o.kind ?? WagerTransactionKind.Bet,
    money,
    referenceExternalTransactionId: o.reference,
  };
  return WagerTransaction.create({
    ...fields,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(fields),
    money: Money.from(money),
    createdAt: o.createdAt ?? T0,
  });
}
