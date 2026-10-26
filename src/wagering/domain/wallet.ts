import { CurrencyMismatchError } from "@/shared/domain/domain-error";
import { Money } from "@/shared/domain/money";
import { uuidv7 } from "@/shared/domain/uuid";
import { InsufficientFundsError, InvalidWalletError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  transactionId: string;
  money: Money;
  at: Date;
  entryId?: string;
}

export interface OpenWalletProps {
  id?: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId?: string;
  now: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, now } = props;
    if (!props.playerId?.trim()) throw new InvalidWalletError("playerId is required");
    if (initialBalance.isNegative()) throw new InvalidWalletError("initial balance cannot be negative");

    const id = props.id ?? uuidv7(now.getTime());
    const wallet = new Wallet(id, props.playerId, initialBalance.currency, initialBalance, 1, now, now);

    if (initialBalance.isZero()) return { wallet };

    if (!props.openingTransactionId) {
      throw new InvalidWalletError("openingTransactionId is required when initial balance > 0");
    }
    const openingEntry = WalletLedgerEntry.create({
      walletId: id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.money)) throw new InsufficientFundsError(this.id);
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  move(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(movement) : this.credit(movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    // o lançamento é criado antes de mexer no saldo: se a validação falhar, a wallet não muda
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
