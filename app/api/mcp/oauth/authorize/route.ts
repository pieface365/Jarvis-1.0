import { constantTimeEquals, signAuthCode } from '../crypto'
import {
  MCP_SCOPES_GRANTED,
  mcpResourceUrl,
  oauthPaths,
  oauthSecret,
  originOf,
} from '../shared'

// OAuth 2.1 authorization endpoint for the single-user, stateless server.
//
// There is no login on the base, so the consent gate IS the owner's secret: GET
// renders a minimal form asking for `MCP_TOKEN`, POST checks it (constant-time)
// and — only on a correct token — mints a short-lived, PKCE-bound authorization
// code JWT and 302s back to the client's redirect_uri. A wrong/missing token
// just re-renders the form with an error, so the owner's secret is the only
// thing that can authorize a connection.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = {
  clientId: string
  redirectUri: string
  responseType: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string
  resource: string
  scope: string
}

function redirectBack(redirectUri: string, params: Record<string, string>): Response {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) {
    if (v) u.searchParams.set(k, v)
  }
  return Response.redirect(u.toString(), 302)
}

// Untrusted redirect_uri (missing/invalid): show an error directly, never
// redirect — the open-redirect guard.
function hardError(description: string, status = 400): Response {
  return new Response(`Authorization error: ${description}`, {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  })
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri)
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

function consentPage(p: Params, opts: { error?: string } = {}): Response {
  let redirectHost = p.redirectUri
  try {
    redirectHost = new URL(p.redirectUri).host
  } catch {
    /* validated before render */
  }
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
  const errorBlock = opts.error
    ? `<p class="err">${esc(opts.error)}</p>`
    : ''
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Vitality</title>
<style>
  :root { --bg:#04060a; --mint:#6ee7b7; --ink:#e9efe9; --dim:rgba(233,239,233,.62);
    --line:rgba(110,231,183,.25); --err:#ff8a8a; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font-family:Inter,-apple-system,system-ui,sans-serif; display:flex; min-height:100vh;
    align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:420px; border:1px solid var(--line); border-radius:16px;
    padding:32px; background:rgba(110,231,183,.04); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--dim); font-size:14px; line-height:1.6; margin:0 0 16px; }
  .host { font-family:ui-monospace,Menlo,monospace; font-size:13px; color:var(--mint); }
  label { display:block; font-size:13px; color:var(--dim); margin:0 0 8px; }
  input[type=password] { width:100%; font:inherit; font-size:15px; padding:12px;
    border-radius:10px; border:1px solid var(--line); background:#0b0f14; color:var(--ink);
    margin:0 0 20px; }
  .err { color:var(--err); font-size:13px; margin:0 0 16px; }
  .row { display:flex; gap:12px; } button, a.deny { flex:1; font:inherit; font-size:15px;
    font-weight:600; padding:12px; border-radius:999px; cursor:pointer; text-align:center;
    text-decoration:none; border:1px solid var(--line); }
  .allow { background:var(--mint); color:#04060a; border:none; }
  a.deny { background:transparent; color:var(--ink); line-height:1.4; }
</style></head><body>
<div class="card">
  <h1>Connect to your dashboard</h1>
  <p>A client at <span class="host">${esc(redirectHost)}</span> wants to connect to your
     Vitality MCP. Enter your <strong>MCP token</strong> to allow it.</p>
  ${errorBlock}
  <form method="POST" action="${esc(oauthPaths.authorize)}">
    ${hidden('client_id', p.clientId)}
    ${hidden('redirect_uri', p.redirectUri)}
    ${hidden('response_type', p.responseType)}
    ${hidden('code_challenge', p.codeChallenge)}
    ${hidden('code_challenge_method', p.codeChallengeMethod)}
    ${hidden('state', p.state)}
    ${hidden('resource', p.resource)}
    ${hidden('scope', p.scope)}
    <label for="mcp_token">MCP token</label>
    <input id="mcp_token" type="password" name="mcp_token" autocomplete="off" autofocus
      placeholder="your MCP_TOKEN">
    <div class="row">
      <a class="deny" href="${esc(p.redirectUri)}?error=access_denied${p.state ? '&amp;state=' + esc(encodeURIComponent(p.state)) : ''}">Cancel</a>
      <button class="allow" type="submit">Allow</button>
    </div>
  </form>
</div></body></html>`
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function readGetParams(req: Request): Params {
  const p = new URL(req.url).searchParams
  return {
    clientId: p.get('client_id') ?? '',
    redirectUri: p.get('redirect_uri') ?? '',
    responseType: p.get('response_type') ?? 'code',
    codeChallenge: p.get('code_challenge') ?? '',
    codeChallengeMethod: p.get('code_challenge_method') ?? '',
    state: p.get('state') ?? '',
    resource: p.get('resource') ?? '',
    scope: p.get('scope') ?? '',
  }
}

// GET — validate the request shape, then render the token-entry consent form. No
// state change; no code is minted here.
export async function GET(req: Request): Promise<Response> {
  if (!process.env.MCP_TOKEN) return hardError('connector not configured', 503)
  const origin = originOf(req)
  const p = readGetParams(req)

  if (!p.clientId || !p.redirectUri) return hardError('missing client_id or redirect_uri')
  if (!isValidRedirectUri(p.redirectUri)) return hardError('invalid redirect_uri')

  // redirect_uri is trusted now → protocol errors go back to the client.
  if (p.responseType !== 'code') {
    return redirectBack(p.redirectUri, { error: 'unsupported_response_type', state: p.state })
  }
  if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
    return redirectBack(p.redirectUri, {
      error: 'invalid_request',
      error_description: 'PKCE S256 required',
      state: p.state,
    })
  }
  if (p.resource && p.resource !== mcpResourceUrl(origin)) {
    return redirectBack(p.redirectUri, { error: 'invalid_target', state: p.state })
  }

  return consentPage(p)
}

// POST — the consent submit. The owner's MCP_TOKEN is the authorization: correct
// → mint a PKCE-bound code and redirect; wrong → re-render the form with an error.
export async function POST(req: Request): Promise<Response> {
  const expected = process.env.MCP_TOKEN
  const secret = oauthSecret()
  if (!expected || !secret) return hardError('connector not configured', 503)
  const origin = originOf(req)

  // Same-origin guard (only when an Origin header is present): the form is
  // served from our origin, so a cross-site auto-submit is rejected.
  const reqOrigin = req.headers.get('origin')
  if (reqOrigin) {
    try {
      if (new URL(reqOrigin).host !== (req.headers.get('x-forwarded-host') ?? req.headers.get('host'))) {
        return hardError('bad origin')
      }
    } catch {
      return hardError('bad origin')
    }
  }

  const form = await req.formData()
  const p: Params = {
    clientId: String(form.get('client_id') ?? ''),
    redirectUri: String(form.get('redirect_uri') ?? ''),
    responseType: String(form.get('response_type') ?? 'code'),
    codeChallenge: String(form.get('code_challenge') ?? ''),
    codeChallengeMethod: String(form.get('code_challenge_method') ?? ''),
    state: String(form.get('state') ?? ''),
    resource: String(form.get('resource') ?? ''),
    scope: String(form.get('scope') ?? ''),
  }
  const mcpToken = String(form.get('mcp_token') ?? '')

  // Re-validate the request shape (form fields are user-editable).
  if (!p.redirectUri || !isValidRedirectUri(p.redirectUri)) return hardError('invalid redirect_uri')
  if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') return hardError('PKCE S256 required')

  if (!mcpToken || !constantTimeEquals(mcpToken, expected)) {
    return consentPage(p, { error: 'That MCP token was not correct. Try again.' })
  }

  const code = signAuthCode(
    {
      codeChallenge: p.codeChallenge,
      redirectUri: p.redirectUri,
      resource: mcpResourceUrl(origin),
      scope: MCP_SCOPES_GRANTED,
    },
    secret,
  )
  return redirectBack(p.redirectUri, { code, state: p.state })
}
