import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { Scope } from '../tools/common.js';

/** OAuth scopes and the tool groups they unlock. */
export const SCOPES: Record<Scope, string> = {
  read: 'applovin:read',
  propose: 'applovin:propose',
  apply: 'applovin:apply',
};

const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'];
const TENANT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  /** Key source; createRemoteJWKSet in production, a local JWKS in tests. */
  jwks: JWTVerifyGetKey;
  /** Claim holding the tenant id. */
  tenantClaim: string;
  /** Without a credentials file every token maps to this tenant. */
  fixedTenant?: string | undefined;
}

export const tenantOf = (auth: AuthInfo): string => String(auth.extra?.tenant ?? '');

/**
 * Validates JWT access tokens issued by the configured authorization server:
 * signature (JWKS), issuer, audience, expiry, tenant claim and scopes. The MCP
 * server acts purely as an OAuth resource server.
 */
export class JwtVerifier implements OAuthTokenVerifier {
  constructor(private readonly options: JwtVerifierOptions) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.options.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
      }));
    } catch {
      // Never echo jose's message: it can describe the token.
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
    }

    const claimed = payload[this.options.tenantClaim];
    const tenant = this.options.fixedTenant ?? (typeof claimed === 'string' ? claimed : '');
    if (!TENANT_ID.test(tenant)) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        `Access token has no valid "${this.options.tenantClaim}" claim`,
      );
    }
    const raw = payload.scope ?? payload.scp;
    const scopes = Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string')
      : typeof raw === 'string'
        ? raw.split(' ').filter(Boolean)
        : [];
    const clientId = [payload.azp, payload.client_id, payload.sub].find(
      (v): v is string => typeof v === 'string',
    );
    return {
      token,
      clientId: clientId ?? 'unknown',
      scopes,
      ...(typeof payload.exp === 'number' && { expiresAt: payload.exp }),
      extra: { tenant, subject: typeof payload.sub === 'string' ? payload.sub : undefined },
    };
  }
}

export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
}

/** Local development only (loopback, MCP_AUTH_MODE=none): every request is the default tenant with all scopes. */
export function devAuthInfo(): AuthInfo {
  return {
    token: 'dev',
    clientId: 'dev',
    scopes: Object.values(SCOPES),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { tenant: 'default' },
  };
}
