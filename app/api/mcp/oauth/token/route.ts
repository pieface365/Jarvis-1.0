import {
  signAccessToken,
  signRefreshToken,
  verifyAuthCode,
  verifyPkceS256,
  verifyRefreshToken,
} from '../crypto'
import {
  ACCESS_TTL_SECONDS,
  corsPreflight,
  jsonCors,
  MCP_SCOPE,
  mcpResourceUrl,
  oauthSecret,
  originOf,
} from '../shared'

// OAuth 2.1 token endpoint. Public clients (PKCE) — no client authentication and
// no client_id validation, because this server is stateless: the authorization
// code is a signed JWT carrying its own PKCE challenge + redirect_uri, so we
// verify the code's signature, match the redirect_uri, and check the PKCE
// verifier — all without touching a database.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function readParams(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      const obj = (await req.json()) as Record<string, unknown>
      const sp = new URLSearchParams()
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') sp.set(k, v)
      }
      return sp
    } catch {
      return new URLSearchParams()
    }
  }
  return new URLSearchParams(await req.text())
}

function grantScope(stored: string): string {
  const s = stored.trim()
  return s || MCP_SCOPE
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string): Response {
  return jsonCors({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  })
}

export async function POST(req: Request): Promise<Response> {
  const secret = oauthSecret()
  if (!secret) return jsonCors({ error: 'connector_not_configured' }, { status: 503 })
  const origin = originOf(req)
  const resource = mcpResourceUrl(origin)

  const params = await readParams(req)
  const grantType = params.get('grant_type') ?? ''

  const mint = (scope: string) => ({
    access: signAccessToken({ resource, issuer: origin, scope }, secret),
    refresh: signRefreshToken({ resource, issuer: origin, scope }, secret),
  })

  if (grantType === 'authorization_code') {
    const code = params.get('code') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const codeVerifier = params.get('code_verifier') ?? ''
    if (!code || !redirectUri || !codeVerifier) {
      return jsonCors({ error: 'invalid_request' }, { status: 400 })
    }

    const decoded = verifyAuthCode(code, secret)
    if (!decoded) return jsonCors({ error: 'invalid_grant' }, { status: 400 })
    // redirect_uri must match the one baked into the code (RFC 6749 §4.1.3).
    if (decoded.redirectUri !== redirectUri) {
      return jsonCors({ error: 'invalid_grant' }, { status: 400 })
    }
    // The code's aud must be this deployment's resource.
    if (decoded.resource !== resource) {
      return jsonCors({ error: 'invalid_grant' }, { status: 400 })
    }
    // PKCE: the verifier must hash to the challenge stored in the code.
    if (!verifyPkceS256(codeVerifier, decoded.codeChallenge)) {
      return jsonCors({ error: 'invalid_grant' }, { status: 400 })
    }

    const scope = grantScope(decoded.scope)
    const { access, refresh } = mint(scope)
    return tokenResponse(access, refresh, scope)
  }

  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token') ?? ''
    if (!refreshToken) return jsonCors({ error: 'invalid_request' }, { status: 400 })

    const decoded = verifyRefreshToken(refreshToken, { secret, expectedAud: resource })
    if (!decoded) return jsonCors({ error: 'invalid_grant' }, { status: 400 })

    // Refresh never widens scope beyond what the original grant carried.
    const scope = grantScope(decoded.scope)
    const { access, refresh } = mint(scope)
    return tokenResponse(access, refresh, scope)
  }

  return jsonCors({ error: 'unsupported_grant_type' }, { status: 400 })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
