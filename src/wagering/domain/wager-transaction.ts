import { Money } from "@/shared/domain/money";
import { uuidv7 } from "@/shared/domain/uuid";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import { FailureCode } from "./failure-code";
import { REFERENCE_RETRY_POLICY, nextAttemptAt, type BackoffPolicy } from "./retry-policy";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

const S = WagerTransactionStatus;

const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [S.Pending]: [S.Processed, S.Rejected, S.Failed, S.PendingReference],
  [S.PendingReference]: [S.Processed, S.Rejected, S.Failed, S.PendingReference],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

const MAX_ID_LENGTH = 128;

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const kind = WagerTransaction.assertSubmittableKind(props.kind);
    for (const field of [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "payloadHash",
      "walletId",
      "playerId",
      "roundId",
      "gameId",
    ] as const) {
      WagerTransaction.assertIdentifier(field, props[field]);
    }

    const ref = props.referenceExternalTransactionId;
    if (ref !== undefined) WagerTransaction.assertIdentifier("referenceExternalTransactionId", ref);

    if (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) {
      if (!ref) throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && ref) {
      throw new InvalidWagerTransactionError("BET cannot reference another transaction");
    }
    if (ref && ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("a transaction cannot reference itself");
    }

    if (kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be ${kind === WagerTransactionKind.Loss ? ">= 0" : "> 0"}`);
    }

    return new WagerTransaction(
      props.id ?? uuidv7(props.createdAt.getTime()),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      ref,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static opening(props: { id?: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    if (!props.money.isPositive()) throw new InvalidWagerTransactionError("OPENING amount must be > 0");
    const id = props.id ?? uuidv7(props.at.getTime());
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      id,
      "internal",
      externalId,
      `internal:${externalId}`,
      "internal",
      props.walletId,
      props.playerId,
      "opening",
      "internal",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceCheckAt = undefined;
  }

  markPendingReference(now: Date, policy: BackoffPolicy = REFERENCE_RETRY_POLICY): void {
    this.transitionTo(S.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextAttemptAt(policy, this._referenceAttempts - 1, now);
  }

  hasExhaustedReferenceRetries(policy: BackoffPolicy = REFERENCE_RETRY_POLICY): boolean {
    return this._status === S.PendingReference && this._referenceAttempts + 1 >= policy.maxAttempts;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.transitionTo(S.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(S.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError("ROLLBACK direction requires the reference");
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not produce a ledger entry");
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      resultBalance: this._resultBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceCheckAt: this._nextReferenceCheckAt,
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  private static assertSubmittableKind(kind: string): WagerTransactionKind {
    if (!SUBMITTABLE_KINDS.includes(kind as WagerTransactionKind)) {
      throw new InvalidWagerTransactionError(`kind "${kind}" is not accepted`);
    }
    return kind as WagerTransactionKind;
  }

  private static assertIdentifier(field: string, value: unknown): void {
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ID_LENGTH) {
      throw new InvalidWagerTransactionError(`${field} must be a non-empty string up to ${MAX_ID_LENGTH} chars`);
    }
  }
}
