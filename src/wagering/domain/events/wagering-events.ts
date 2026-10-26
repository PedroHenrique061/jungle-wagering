import type { MoneyProps } from "@/shared/domain/money";
import type { FailureCode } from "../failure-code";
import type { Wallet } from "../wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet-ledger-entry";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionRef {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      ...transactionRef(tx),
      status: tx.status,
      balance: tx.resultBalance!.toJSON(),
      processedAt: tx.processedAt!.toISOString(),
    };
    if (tx.referenceTransactionId) data.referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed(IntegrationEvent.props(tx.id, data, ctx));
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const data: WagerTransactionRejectedData = {
      ...transactionRef(tx),
      failureCode: tx.failureCode!,
      rejectedAt: tx.processedAt!.toISOString(),
    };
    if (tx.referenceExternalTransactionId) data.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    return new WagerTransactionRejected(IntegrationEvent.props(tx.id, data, ctx));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(
        tx.id,
        {
          ...transactionRef(tx),
          referenceExternalTransactionId: tx.referenceExternalTransactionId!,
          attempts: tx.referenceAttempts,
          nextCheckAt: tx.nextReferenceCheckAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}
