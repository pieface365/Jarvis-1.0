import { NextResponse } from 'next/server'
import { fitbitEnv, writeTokens } from '@/lib/fitbit/server'

/** Google redirects here with ?code — exchange it for tokens, then land back
 *  on the dashboard with ?fitbit=connected|error for a visible outcome. */
export async function GET(req: Request) {
  const env = fitbitEnv()
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  if (!env || url.searchParams.get('error') || !code) {
    return NextResponse.redirect(new URL('/?fitbit=error', url.origin))
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.redirectUri,
    }),
  })
  if (!res.ok) return NextResponse.redirect(new URL('/?fitbit=error', url.origin))
  const j = await res.json()
  if (!j.access_token || !j.refresh_token) {
    return NextResponse.redirect(new URL('/?fitbit=error', url.origin))
  }
  await writeTokens({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  })
  return NextResponse.redirect(new URL('/?fitbit=connected', url.origin))
}
