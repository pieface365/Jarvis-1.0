import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  OWNER_SUBJECT,
  REFRESH_TTL_SECONDS,
  TOKEN_USE_ACCESS,
  TOKEN_USE_CODE,
  TOKEN_USE_REFRESH,
} from './shared'

// All crypto for the stateless OAuth server. Pure node:crypto — no jose, no
// jsonwebtoken, no new dependency. Every OAuth artifact (authorization code,
// access token, refresh token) is a compact HS256 JWT; there is nothing to
// store because the signature is the only thing we verify.

const b64urlJson = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')

/** Sign an HS256 JWT with the given payload. Adds no claims of its own. */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

/**
 * Verify an HS256 JWT: pin alg=HS256 (reject alg-confusion / "none"),
 * timing-safe signature check, and not-expired. Returns the decoded payload or
 * null. The caller checks `token_use` / `aud` for its own purpose.
 */
function verifyJwt(jwt: string, secret: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const [encodedHeader, encodedPayload, encodedSig] = parts
  const signingInput = `${encodedHeader}.${encodedPayload}`

  let header: { alg?: string }
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header.alg !== 'HS256') return null

  const expected = createHmac('sha256', secret).update(signingInput).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(encodedSig, 'base64url')
  } catch {
    return null
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < now) return null
  return payload
}

// ── Authorization code ───────────────────────────────────────────────────────
// A short-lived JWT that carries the PKCE challenge + redirect_uri so /token can
// re-verify them without any server-side state.

export function signAuthCode(
  data: { codeChallenge: string; redirectUri: string; resource: string; scope: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      sub: OWNER_SUBJECT,
      token_use: TOKEN_USE_CODE,
      code_challenge: data.codeChallenge,
      redirect_uri: data.redirectUri,
      resource: data.resource,
      scope: data.scope,
      iat: now,
      exp: now + CODE_TTL_SECONDS,
    },
    secret,
  )
}

export type AuthCode = {
  codeChallenge: string
  redirectUri: string
  resource: string
  scope: string
}

export function verifyAuthCode(jwt: string, secret: string): AuthCode | null {
  const p = verifyJwt(jwt, secret)
  if (!p || p.token_use !== TOKEN_USE_CODE) return null
  if (
    typeof p.code_challenge !== 'string' ||
    typeof p.redirect_uri !== 'string' ||
    typeof p.resource !== 'string'
  ) {
    return null
  }
  return {
    codeChallenge: p.code_challenge,
    redirectUri: p.redirect_uri,
    resource: p.resource,
    scope: typeof p.scope === 'string' ? p.scope : '',
  }
}

// ── Access token ─────────────────────────────────────────────────────────────
// The bearer the OAuth client presents to /api/mcp/mcp. `aud` binds it to this
// exact resource (RFC 8707) so nothing else can be replayed as an MCP bearer.

export function signAccessToken(
  data: { resource: string; issuer: string; scope: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      sub: OWNER_SUBJECT,
      aud: data.resource,
      iss: data.issuer,
      scope: data.scope,
      token_use: TOKEN_USE_ACCESS,
      iat: now,
      exp: now + ACCESS_TTL_SECONDS,
    },
    secret,
  )
}

/** Verify an access token for this resource. Returns its scope or null. */
export function verifyAccessToken(
  jwt: string,
  opts: { secret: string; expectedAud: string },
): { scope: string } | null {
  const p = verifyJwt(jwt, opts.secret)
  if (!p || p.token_use !== TOKEN_USE_ACCESS) return null
  if (p.aud !== opts.expectedAud) return null
  return { scope: typeof p.scope === 'string' ? p.scope : '' }
}

// ── Refresh token ────────────────────────────────────────────────────────────

export function signRefreshToken(
  data: { resource: string; issuer: string; scope: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      sub: OWNER_SUBJECT,
      aud: data.resource,
      iss: data.issuer,
      scope: data.scope,
      token_use: TOKEN_USE_REFRESH,
      iat: now,
      exp: now + REFRESH_TTL_SECONDS,
    },
    secret,
  )
}

export function verifyRefreshToken(
  jwt: string,
  opts: { secret: string; expectedAud: string },
): { scope: string } | null {
  const p = verifyJwt(jwt, opts.secret)
  if (!p || p.token_use !== TOKEN_USE_REFRESH) return null
  if (p.aud !== opts.expectedAud) return null
  return { scope: typeof p.scope === 'string' ? p.scope : '' }
}

// ── PKCE + misc ──────────────────────────────────────────────────────────────

/** RFC 7636 S256: base64url(sha256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Public, non-secret client identifier issued at DCR. */
export function randomClientId(): string {
  return `mcpc_${randomBytes(24).toString('base64url')}`
}

/** Constant-time equality for the raw MCP_TOKEN comparison. */
export function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** A JWT-looking bearer (3 non-empty base64url segments). */
export function looksLikeJwt(bearer: string): boolean {
  const parts = bearer.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}
