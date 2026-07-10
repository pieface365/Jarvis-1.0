import {
  corsPreflight,
  jsonCors,
  MCP_SCOPES_SUPPORTED,
  mcpResourceUrl,
  oauthSecret,
  originOf,
} from '../shared'

// RFC 9728 Protected Resource Metadata. Served (via next.config rewrite) at the
// canonical `/.well-known/oauth-protected-resource`, which is also the URL the
// MCP route advertises in its `WWW-Authenticate: resource_metadata=...` 401. It
// tells the client which Authorization Server to use — us (the request origin).
// `resource` MUST string-equal the JSON-RPC endpoint (/api/mcp/mcp) for RFC 8707
// audience binding.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  if (!oauthSecret()) return jsonCors({ error: 'connector_not_configured' }, { status: 503 })
  const origin = originOf(req)

  return jsonCors({
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: MCP_SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
  })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
