import { createHash } from 'node:crypto'

// Shared constants + helpers for the single-user, STATELESS MCP OAuth 2.1
// authorization server. This lets claude.ai / Claude Desktop / cloud scheduled
// tasks connect to the base's MCP as a remote connector (they require OAuth, not
// a bare bearer token).
//
// Unlike the multi-user hosted app this was adapted from, there is no login, no
// user table, and no OAuth storage: authorization codes, access tokens and
// refresh tokens are all self-contained HS256 JWTs signed with one server
// secret. The OWNER'S `MCP_TOKEN` (entered on the /authorize consent page) is
// the only thing that can authorize a connection.

export const MCP_SCOPE = 'mcp:read'
export const MCP_WRITE_SCOPE = 'mcp:write'
// A fresh connection is granted both; the tools decide what they honour.
export const MCP_SCOPES_GRANTED = `${MCP_SCOPE} ${MCP_WRITE_SCOPE}`
export const MCP_SCOPES_SUPPORTED = [MCP_SCOPE, MCP_WRITE_SCOPE]

// TTLs. Access is short because it is verified statelessly (no revocation list),
// so its lifetime bounds how long a leaked token stays live.
export const ACCESS_TTL_SECONDS = 60 * 60 // 1h
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30 // 30d
export const CODE_TTL_SECONDS = 90 // authorization code: short-lived

// token_use claim values — pin what a JWT is allowed to be used for so a code
// can never be replayed as an access token, etc.
export const TOKEN_USE_CODE = 'mcp_code'
export const TOKEN_USE_ACCESS = 'mcp_access'
export const TOKEN_USE_REFRESH = 'mcp_refresh'

// The single synthetic subject: there is exactly one owner.
export const OWNER_SUBJECT = 'owner'

/**
 * The public origin of this deployment, derived from the request so it works on
 * any Vercel domain (preview, prod, custom) with no hardcoded URL. Trusts the
 * `x-forwarded-*` headers Vercel sets in front of the function.
 */
export function originOf(req: Request): string {
  const h = req.headers
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? ''
  const proto =
    h.get('x-forwarded-proto') ??
    (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

/** The protected-resource identifier (RFC 8707): MUST string-equal the URL that
 *  clients POST JSON-RPC to, and the `aud` we stamp on access tokens. */
export function mcpResourceUrl(origin: string): string {
  return `${origin}/api/mcp/mcp`
}

/** The `resource_metadata` URL advertised in the 401 WWW-Authenticate header. */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`
}

/**
 * HS256 secret for every OAuth JWT (codes, access, refresh). Prefer an explicit
 * `MCP_OAUTH_SECRET`; otherwise derive one deterministically from `MCP_TOKEN`,
 * so a forker who only sets `MCP_TOKEN` still gets a working (and stable) OAuth
 * signing key. Returns null only when neither is set (connector disabled → 503).
 */
export function oauthSecret(): string | null {
  const explicit = process.env.MCP_OAUTH_SECRET
  if (explicit) return explicit
  const mcpToken = process.env.MCP_TOKEN
  if (mcpToken) {
    return createHash('sha256').update(`vitality-base:mcp-oauth:${mcpToken}`).digest('hex')
  }
  return null
}

export const oauthPaths = {
  authorize: '/api/mcp/oauth/authorize',
  token: '/api/mcp/oauth/token',
  register: '/api/mcp/oauth/register',
} as const

// CORS: browser MCP clients (claude.ai web) fetch discovery + token cross-origin.
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function jsonCors(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  })
}
