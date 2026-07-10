import { randomClientId } from '../crypto'
import { corsPreflight, jsonCors, oauthSecret } from '../shared'

// RFC 7591 Dynamic Client Registration. Open + unauthenticated — that is how MCP
// clients self-register. Because this server is stateless, we do NOT persist the
// client: we accept any valid registration and hand back a random client_id.
// /token never validates client_id against a store (there isn't one); the code's
// PKCE binding is what actually protects the exchange, and the owner's MCP_TOKEN
// is what gates minting a code in the first place.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || !uri) return false
  try {
    const u = new URL(uri)
    // https anywhere, or http on loopback (RFC 8252 native clients). Reject
    // plain http to arbitrary hosts and exotic schemes.
    if (u.protocol === 'https:') return true
    if (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!oauthSecret()) return jsonCors({ error: 'connector_not_configured' }, { status: 503 })

  let body: { redirect_uris?: unknown; client_name?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonCors({ error: 'invalid_client_metadata' }, { status: 400 })
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
    return jsonCors(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be absolute https (or loopback http) URIs' },
      { status: 400 },
    )
  }
  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : null

  return jsonCors(
    {
      client_id: randomClientId(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(clientName ? { client_name: clientName } : {}),
    },
    { status: 201 },
  )
}

export function OPTIONS(): Response {
  return corsPreflight()
}
