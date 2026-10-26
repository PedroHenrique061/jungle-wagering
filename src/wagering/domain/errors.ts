import { DomainError } from "@/shared/domain/domain-error";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds`);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
  constructor(detail: string) {
    super(`Ledger entry is not balanced: ${detail}`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
  constructor(reason: string) {
    super(`Invalid wallet: ${reason}`);
  }
}
