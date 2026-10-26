import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./request-context";

/**
 * Identidade do chamador, resolvida por um Identity Provider externo (OIDC).
 * Nenhuma implementação é registrada neste desafio — ver ARCHITECTURE.md, "Autenticação".
 */
export interface ProviderIdentity {
  /** `sub`/`azp` do token, mapeado para o providerId de domínio. */
  providerId: string;
  scopes: string[];
}

export interface ProviderIdentityPort {
  /** Valida o bearer token (assinatura via JWKS, iss, aud, exp) e devolve a identidade. */
  resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/**
 * Ponto de extensão de autenticação — NO-OP por decisão de escopo (autenticação não pontua
 * no desafio). Para ativar: registrar um ProviderIdentityPort (ex.: Keycloak via JWKS),
 * negar quando `resolve` devolver undefined e comparar identity.providerId com body.providerId.
 * Rotas marcadas com @Public() (health, métricas) continuam abertas.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    // Extensão: const identity = await this.identity.resolve(req.headers.authorization) …
    return true;
  }
}
