import { type ExecutionContext, createParamDecorator, SetMetadata } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { uuidv7 } from "@/shared/domain/uuid";

export type RequestWithContext = Request & { correlationId?: string };

const CORRELATION_HEADER = "x-correlation-id";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propaga X-Correlation-Id (ou gera um UUIDv7) e o devolve na resposta. */
export function correlationIdMiddleware(req: RequestWithContext, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<RequestWithContext>();
  return req.correlationId ?? uuidv7();
});

/** Marca rotas abertas (health, métricas): o guard de autenticação as ignora. */
export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);
