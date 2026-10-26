import type { MoneyProps } from "@/shared/domain/money";
import type { Logger } from "@/shared/observability/logger";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { toWalletView, type WalletView } from "./create-wallet";
import { InvalidRequestError, ResourceNotFoundError } from "./errors";
import type { WageringMetrics } from "./metrics";
import type { ReadRepositories, UnitOfWork } from "./ports";

// ---------------------------------------------------------------- views

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  referenceAttempts?: number;
  nextReferenceCheckAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  const view: TransactionView = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    createdAt: tx.createdAt.toISOString(),
  };
  if (tx.failureCode) view.failureCode = tx.failureCode;
  if (tx.referenceExternalTransactionId) view.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId) view.referenceTransactionId = tx.referenceTransactionId;
  if (tx.resultBalance) view.balance = tx.resultBalance.toJSON();
  if (tx.referenceAttempts > 0) view.referenceAttempts = tx.referenceAttempts;
  if (tx.nextReferenceCheckAt) view.nextReferenceCheckAt = tx.nextReferenceCheckAt.toISOString();
  if (tx.processedAt) view.processedAt = tx.processedAt.toISOString();
  return view;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

const toLedgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export interface LedgerPageView {
  walletId: string;
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

// ---------------------------------------------------------------- cursor opaco

/**
 * Cursor = base64url("v1:<walletId>:<seq>"). Opaco para o cliente, estável (seq é monotônico e
 * nunca reutilizado, e o ledger é append-only) e amarrado à wallet: não serve em outra.
 */
export function encodeLedgerCursor(walletId: string, seq: string): string {
  return Buffer.from(`v1:${walletId}:${seq}`, "utf8").toString("base64url");
}

export function decodeLedgerCursor(walletId: string, cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidRequestError("invalid cursor");
  }
  const [version, cursorWallet, seq] = decoded.split(":");
  if (version !== "v1" || cursorWallet !== walletId || !seq || !/^\d{1,19}$/.test(seq)) {
    throw new InvalidRequestError("invalid cursor");
  }
  return seq;
}

// ---------------------------------------------------------------- queries

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export class WalletQueries {
  constructor(
    private readonly read: ReadRepositories,
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.read.wallets.findById(walletId);
    if (!wallet) throw new ResourceNotFoundError("wallet", walletId);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limitRaw: unknown): Promise<LedgerPageView> {
    const limit = parseLimit(limitRaw);
    const wallet = await this.read.wallets.findById(walletId);
    if (!wallet) throw new ResourceNotFoundError("wallet", walletId);
    const afterSeq = cursor ? decodeLedgerCursor(walletId, cursor) : undefined;
    const page = await this.read.ledger.page(walletId, afterSeq, limit);
    return {
      walletId,
      items: page.entries.map(toLedgerEntryView),
      nextCursor: page.nextAfterSeq ? encodeLedgerCursor(walletId, page.nextAfterSeq) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.read.transactions.findById(transactionId);
    if (!tx) throw new ResourceNotFoundError("transaction", transactionId);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.read.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) throw new ResourceNotFoundError("transaction", `${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }

  /**
   * Compara saldo materializado com o saldo reconstruído do ledger. Lê ambos sob o lock da wallet,
   * para que nenhuma movimentação concorrente produza uma divergência falsa.
   * Divergência NÃO é corrigida: é logada, contada em métrica e sinalizada na resposta.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationView> {
    const view = await this.uow.run(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      if (!wallet) throw new ResourceNotFoundError("wallet", walletId);
      const totals = await repos.ledger.totals(walletId, wallet.currency);
      const difference = wallet.balance.subtract(totals.calculatedBalance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: totals.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.entries,
      } satisfies ReconciliationView;
    });

    this.metrics.reconciliation(view.consistent);
    if (!view.consistent) {
      this.logger.error("wallet reconciliation mismatch", {
        correlationId,
        walletId,
        checkedEntries: view.checkedEntries,
        differenceDetected: true,
      });
    }
    return view;
  }
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return LEDGER_DEFAULT_LIMIT;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > LEDGER_MAX_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`);
  }
  return value;
}
