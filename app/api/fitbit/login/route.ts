import { NextResponse } from 'next/server'
import { fitbitEnv } from '@/lib/fitbit/server'

/**
 * Visit /api/fitbit/login once to connect. Redirects to Google's consent
 * screen with the Fitbit data scopes; access_type=offline + prompt=consent
 * guarantee a refresh token so this is a one-time ceremony.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/fitbit.heartrate.read', // resting HR + HRV
  'https://www.googleapis.com/auth/fitbit.sleep.read', // duration + efficiency
]

export async function GET() {
  const env = fitbitEnv()
  if (!env) {
    return NextResponse.json(
      { error: 'FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET missing — add them to .env.local and restart dev' },
      { status: 500 },
    )
  }
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', env.clientId)
  u.searchParams.set('redirect_uri', env.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  return NextResponse.redirect(u)
}
