import { NextRequest, NextResponse } from 'next/server'
import { GATE_COOKIE, gateToken } from '@/lib/gate'

/**
 * Built-in password gate — free stand-in for Vercel's paid production
 * Deployment Protection. Active ONLY when DASHBOARD_PASSWORD is set (so
 * localhost dev stays open). Everything is locked behind one cookie: pages,
 * API routes (the Fitbit vitals feed), tiles, and the JS bundles (which
 * embed the public Supabase anon key — gating them keeps the tile_data
 * table's location out of strangers' hands too).
 */

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vitality</title>
<style>
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#050506;color:#ededf0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  form{display:flex;flex-direction:column;gap:14px;width:min(320px,86vw);padding:28px;border:1px solid #1d1d22;border-radius:16px;background:#0e0e11}
  h1{margin:0;font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:26px}
  p{margin:0;color:#84848c;font-size:13px}
  input{background:#050506;border:1px solid #2a2a31;color:#ededf0;border-radius:10px;padding:11px 13px;font:inherit;outline:none}
  input:focus{border-color:#6EE7B7}
  button{background:#6EE7B7;color:#04140d;border:none;border-radius:10px;padding:12px;font:inherit;font-weight:600;cursor:pointer}
</style></head><body>
<form method="POST" action="/api/gate">
  <h1>Vitality</h1>
  <p>This dashboard is private. Enter the password to continue.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Unlock</button>
</form></body></html>`

export async function middleware(req: NextRequest) {
  const pass = process.env.DASHBOARD_PASSWORD
  if (!pass) return NextResponse.next()
  const { pathname } = req.nextUrl
  if (pathname === '/api/gate') return NextResponse.next()
  const cookie = req.cookies.get(GATE_COOKIE)?.value
  if (cookie && cookie === (await gateToken(pass))) return NextResponse.next()
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'locked', hint: 'unlock the dashboard first' }, { status: 401 })
  }
  return new NextResponse(LOGIN_HTML, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/* Gate everything (including /_next bundles and /tiles) except favicon. */
export const config = { matcher: ['/((?!favicon\\.ico).*)'] }
