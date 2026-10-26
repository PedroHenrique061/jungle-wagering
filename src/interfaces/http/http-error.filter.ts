import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { DomainError } from "@/shared/domain/domain-error";
import { LOGGER, type Logger } from "@/shared/observability/logger";
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  ResourceNotFoundError,
  UnprocessableTransactionError,
  WalletAlreadyExistsError,
} from "@/wagering/application/errors";
import { InsufficientFundsError, InvalidTransactionStateError } from "@/wagering/domain/errors";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const { status, code, message, retryable, details } = classify(error);

    if (status >= 500) {
      this.logger.error("request failed", {
        correlationId: req.correlationId,
        method: req.method,
        path: req.route?.path ?? req.path,
        status,
        code,
        error,
      });
    }
    if (retryable) res.setHeader("Retry-After", "1");
    res.status(status).json({
      error: { code, message, retryable, ...(details ? { details } : {}) },
      correlationId: req.correlationId,
    });
  }
}

interface Classified {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function classify(error: unknown): Classified {
  if (error instanceof InvalidRequestError) return client(400, error.code, error.message);
  if (error instanceof ResourceNotFoundError) return client(404, error.code, error.message);
  if (error instanceof IdempotencyConflictError) {
    return client(409, error.code, error.message, { existingTransactionId: error.existingTransactionId });
  }
  if (error instanceof ExternalTransactionConflictError) {
    return client(409, error.code, error.message, { existingTransactionId: error.existingTransactionId });
  }
  if (error instanceof WalletAlreadyExistsError) return client(409, error.code, error.message);
  if (error instanceof UnprocessableTransactionError) {
    return client(422, error.failureCode, error.message, { failureCode: error.failureCode });
  }
  if (error instanceof ApplicationError) {
    return error.transient
      ? { status: 503, code: error.code, message: "Temporarily unavailable, retry with the same Idempotency-Key", retryable: true }
      : { status: 500, code: error.code, message: "Internal error", retryable: false };
  }
  if (error instanceof InvalidTransactionStateError) {
    return { status: 500, code: error.code, message: "Internal error", retryable: false };
  }
  if (error instanceof InsufficientFundsError) return client(422, error.code, error.message);
  if (error instanceof DomainError) return client(400, error.code, error.message);

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: status === 404 ? "ROUTE_NOT_FOUND" : `HTTP_${status}`, message: error.message, retryable: status >= 500 };
  }
  const parserStatus = (error as { status?: unknown; type?: unknown })?.status;
  if (typeof parserStatus === "number" && parserStatus >= 400 && parserStatus < 500) {
    return client(parserStatus, "INVALID_BODY", "Request body could not be parsed");
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal error", retryable: false };
}

const client = (status: number, code: string, message: string, details?: Record<string, unknown>): Classified => ({
  status,
  code,
  message,
  retryable: false,
  ...(details ? { details } : {}),
});
