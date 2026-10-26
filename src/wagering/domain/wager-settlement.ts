import { FailureCode } from "./failure-code";
import { REFERENCE_RETRY_POLICY, type BackoffPolicy } from "./retry-policy";
import { InvalidTransactionStateError } from "./errors";
import { Wallet } from "./wallet";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";
import {
  ALLOWED_REFERENCE_KINDS,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

export interface SettlementContext {
  transaction: WagerTransaction;
  /** Wallet já carregada SOB LOCK pelo use case (a unidade de concorrência). */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ainda não chegou. */
  reference?: WagerTransaction;
  /** true se a referência já é alvo de um REFUND/ROLLBACK PROCESSED. */
  referenceAlreadyReversed: boolean;
  now: Date;
  policy?: BackoffPolicy;
}

export type SettlementOutcome =
  | { type: "PROCESSED"; ledgerEntry?: WalletLedgerEntry }
  | { type: "REJECTED"; failureCode: FailureCode }
  | { type: "PENDING_REFERENCE"; attempts: number; nextCheckAt: Date };

/**
 * Serviço de domínio puro: decide e aplica o efeito de uma transação sobre a wallet.
 * Não faz I/O. Muta `transaction` e `wallet`; o chamador persiste tudo numa única transação SQL.
 *
 * Ordem de validação (a primeira que falhar define o failureCode):
 *  1. wallet pertence ao player e usa a mesma moeda
 *  2. referência (quando houver): existência → estado → escopo → kind → valor → reversão única
 *  3. efeito no saldo (débito sem saldo → INSUFFICIENT_FUNDS ou REVERSAL_INSUFFICIENT_FUNDS)
 */
export class WagerSettlement {
  static settle(ctx: SettlementContext): SettlementOutcome {
    const { transaction: tx, wallet, now } = ctx;
    const policy = ctx.policy ?? REFERENCE_RETRY_POLICY;

    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(tx.id, tx.status, "settle");
    }

    if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) {
      return WagerSettlement.reject(tx, wallet, FailureCode.WalletPlayerMismatch, now);
    }
    if (wallet.currency !== tx.money.currency) {
      return WagerSettlement.reject(tx, wallet, FailureCode.CurrencyMismatch, now);
    }

    const { reference } = ctx;
    if (tx.referenceExternalTransactionId) {
      // Referência ainda não chegou, ou chegou mas também está aguardando/pendente.
      const waiting =
        !reference ||
        reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference;
      if (waiting) {
        if (tx.status === WagerTransactionStatus.PendingReference && tx.hasExhaustedReferenceRetries(policy)) {
          return WagerSettlement.reject(tx, wallet, FailureCode.ReferenceNotFound, now);
        }
        tx.markPendingReference(now, policy);
        return { type: "PENDING_REFERENCE", attempts: tx.referenceAttempts, nextCheckAt: tx.nextReferenceCheckAt! };
      }

      const failure = WagerSettlement.validateReference(tx, reference, ctx.referenceAlreadyReversed);
      if (failure) return WagerSettlement.reject(tx, wallet, failure, now);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { type: "PROCESSED" };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return WagerSettlement.reject(tx, wallet, code, now);
    }

    const ledgerEntry = wallet.move(direction, { transactionId: tx.id, money: tx.money, at: now });
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { type: "PROCESSED", ledgerEntry };
  }

  private static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    const sameScope =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameScope) return FailureCode.ReferenceMismatch;

    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }

  private static reject(
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
  ): SettlementOutcome {
    tx.reject(code, now, wallet.balance);
    return { type: "REJECTED", failureCode: code };
  }
}

/** Kinds de reversão (para o índice único de "reversão única por referência"). */
export const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const;
