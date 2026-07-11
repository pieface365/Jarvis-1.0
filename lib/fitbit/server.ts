import { promises as fs } from 'fs'
import path from 'path'

/**
 * Server-side Fitbit plumbing. Fitbit auth runs through Google OAuth since the
 * acquisition: tokens come from oauth2.googleapis.com, data still comes from
 * api.fitbit.com. Tokens live in a git-ignored file at the project root — this
 * dashboard is a single-user, local-first app, so a file is the honest store
 * (the Supabase seam is the upgrade path if this ever deploys multi-user).
 */

const TOKEN_FILE = path.join(process.cwd(), '.fitbit-tokens.json')

export interface FitbitTokens {
  access_token: string
  refresh_token: string
  /** epoch ms when access_token dies */
  expires_at: number
}

export function fitbitEnv() {
  const clientId = process.env.FITBIT_CLIENT_ID
  const clientSecret = process.env.FITBIT_CLIENT_SECRET
  const redirectUri = process.env.FITBIT_REDIRECT_URI || 'http://localhost:3000/api/fitbit/callback'
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri }
}

export async function readTokens(): Promise<FitbitTokens | null> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}

export async function writeTokens(t: FitbitTokens): Promise<void> {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2))
}

/** Valid access token, refreshing through Google when expired. Null = not connected. */
export async function getAccessToken(): Promise<string | null> {
  const env = fitbitEnv()
  const t = await readTokens()
  if (!env || !t) return null
  if (Date.now() < t.expires_at - 60_000) return t.access_token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    }),
  })
  if (!res.ok) return null
  const j = await res.json()
  const next: FitbitTokens = {
    access_token: j.access_token,
    // Google usually omits refresh_token on refresh; keep the one we have
    refresh_token: j.refresh_token || t.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  }
  await writeTokens(next)
  return next.access_token
}

/** GET against the Google Health API (the Fitbit Web API's replacement). */
export async function healthGet(pathAndQuery: string, token: string): Promise<any> {
  const res = await fetch('https://health.googleapis.com/v4' + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    const err = new Error(`health api ${res.status} on ${pathAndQuery}: ${body}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * List a data type's points for the last `days` days. Tries a server-side
 * civil-time filter first; the filter grammar is lightly documented, so on a
 * 400 it falls back to an unfiltered page and lets the caller date-filter.
 */
export async function listDataPoints(dataType: string, filter: string | null, token: string): Promise<any[]> {
  const base = `/users/me/dataTypes/${dataType}/dataPoints`
  if (filter) {
    try {
      const j = await healthGet(`${base}?pageSize=200&filter=${encodeURIComponent(filter)}`, token)
      return j.dataPoints || []
    } catch (e: any) {
      if (e?.status !== 400) throw e
    }
  }
  const j = await healthGet(`${base}?pageSize=200`, token)
  return j.dataPoints || []
}
