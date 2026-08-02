import { NextResponse } from 'next/server'
import { GATE_COOKIE, gateToken } from '@/lib/gate'

/** The password gate's unlock endpoint: right password → year-long httpOnly
 *  cookie → back to the dashboard. See middleware.ts for the lock itself. */
export async function POST(req: Request) {
  const pass = process.env.DASHBOARD_PASSWORD
  const home = new URL('/', req.url)
  if (!pass) return NextResponse.redirect(home, 303)
  const form = await req.formData()
  if (String(form.get('password') || '') !== pass) {
    // 200, not 401: the iOS WKWebView (native wrapper) won't render an error-
    // status page — a 401 shows blank/"the URL can't be shown", so a mistyped
    // password would strand the user instead of showing "try again". Same reason
    // the login page in middleware.ts is served as 200.
    return new NextResponse(
      '<!doctype html><body style="background:#050506;color:#e06a6c;font-family:sans-serif;display:grid;place-items:center;min-height:100dvh"><p>Wrong password — <a href="/" style="color:#6EE7B7">try again</a></p></body>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }
  const res = NextResponse.redirect(home, 303)
  res.cookies.set(GATE_COOKIE, await gateToken(pass), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  })
  return res
}
