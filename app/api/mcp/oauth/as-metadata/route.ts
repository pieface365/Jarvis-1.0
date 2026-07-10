import {
  corsPreflight,
  jsonCors,
  MCP_SCOPES_SUPPORTED,
  oauthPaths,
  oauthSecret,
  originOf,
} from '../shared'

// RFC 8414 Authorization Server Metadata. Served (via next.config rewrite) at
// `/.well-known/oauth-authorization-server` — the client builds that URL itself
// from the issuer, so it cannot be relocated. Describes OUR /authorize, /token,
// /register. Public clients + PKCE S256 only. Issuer is derived from the request
// so it is correct on any Vercel domain with no hardcoded URL.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  if (!oauthSecret()) return jsonCors({ error: 'connector_not_configured' }, { status: 503 })
  const origin = originOf(req)

  return jsonCors({
    issuer: origin,
    authorization_endpoint: `${origin}${oauthPaths.authorize}`,
    token_endpoint: `${origin}${oauthPaths.token}`,
    registration_endpoint: `${origin}${oauthPaths.register}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients only (claude.ai uses PKCE, no client secret).
    token_endpoint_auth_methods_supported: ['none'],
    // PKCE is REQUIRED — we reject `plain` and missing challenges at /authorize.
    code_challenge_methods_supported: ['S256'],
    scopes_supported: MCP_SCOPES_SUPPORTED,
  })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
