import { type CanActivate, type ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC } from "./request-context";

export interface ProviderIdentity {
  providerId: string;
  scopes: string[];
}

export interface ProviderIdentityPort {
  resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(PROVIDER_IDENTITY) private readonly identity?: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic || !this.identity) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const caller = await this.identity.resolve(request.headers.authorization);
    return caller !== undefined;
  }
}
