import { Money } from "@/shared/domain/money";
import { uuidv7 } from "@/shared/domain/uuid";
import { UnbalancedLedgerEntryError } from "./errors";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, "id"> & { id?: string };

/**
 * Lançamento imutável do ledger. Sem setters, sem transições; a instância é congelada.
 * A aritmética (before ± money === after) é verificada na factory.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError("money must be positive");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError("balances cannot be negative");
    }
    const entry = new WalletLedgerEntry(
      props.id ?? uuidv7(props.createdAt.getTime()),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução da persistência: não revalida (o banco já garante via CHECK). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }

  /** +money para crédito, -money para débito. Usado na reconciliação. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
