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

/** In-memory cache — the only writable "store" on serverless (Vercel), where
 *  the filesystem is ephemeral. Lives as long as the lambda instance does;
 *  worst case a cold start refreshes the access token again. */
let memoryTokens: FitbitTokens | null = null

export async function readTokens(): Promise<FitbitTokens | null> {
  if (memoryTokens) return memoryTokens
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'))
  } catch {
    /* No file (fresh deploy / serverless): fall back to a refresh token from
       the environment. Google refresh tokens don't rotate on use, so a static
       env var stays valid — connect locally once, copy it to Vercel. */
    const rt = process.env.FITBIT_REFRESH_TOKEN
    return rt ? { access_token: '', refresh_token: rt, expires_at: 0 } : null
  }
}

export async function writeTokens(t: FitbitTokens): Promise<void> {
  memoryTokens = t
  try {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2))
  } catch {
    /* read-only filesystem (Vercel) — the in-memory copy carries the request */
  }
}

/* Single-flight refresh: three data types load in parallel, and concurrent
   refreshes with the same refresh_token are wasteful at best. */
let refreshing: Promise<string | null> | null = null

/**
 * Valid access token, refreshing through Google when expired — or when
 * `force` is set, because Google sometimes invalidates access tokens ahead
 * of their stated expiry (observed in the wild: 401 with 60min "left").
 * Null = not connected.
 */
export async function getAccessToken(force = false): Promise<string | null> {
  const env = fitbitEnv()
  const t = await readTokens()
  if (!env || !t) return null
  if (!force && Date.now() < t.expires_at - 60_000) return t.access_token
  if (!refreshing) {
    refreshing = (async () => {
      try {
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
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

/** GET against the Google Health API (the Fitbit Web API's replacement).
 *  Fetches its own token; a 401 forces one refresh and one retry. */
export async function healthGet(pathAndQuery: string): Promise<any> {
  const attempt = async (token: string) =>
    fetch('https://health.googleapis.com/v4' + pathAndQuery, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    })
  let token = await getAccessToken()
  if (!token) throw Object.assign(new Error('not connected'), { status: 401 })
  let res = await attempt(token)
  if (res.status === 401) {
    token = await getAccessToken(true)
    if (!token) throw Object.assign(new Error('token refresh failed'), { status: 401 })
    res = await attempt(token)
  }
  /* Google throws an occasional 500 mid-pagination (seen 2026-09-09 on a
     sleep page token). A single failed page rejects the whole walk and drops
     that data type from the response for the entire sync, so give a
     transient status a couple of short retries before surfacing it. */
  for (let i = 0; i < 2 && (res.status === 429 || res.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    res = await attempt(token)
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    const err = new Error(`health api ${res.status} on ${pathAndQuery}: ${body}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * List a data type's points, newest first, walking back until the window is
 * covered.
 *
 * No server-side filter: the filter grammar matched nothing in practice (200 +
 * empty), so we paginate and let the caller date-filter. Pages can be empty yet
 * still carry a nextPageToken, so emptiness never stops the walk.
 *
 * The stop condition is a DATE, not a point count. It used to be `all.length <
 * 400`, which quietly capped the walk two pages in — fine for the once-a-day
 * types, but heart-rate-variability arrives 26-128 samples per night, so 400
 * points was about six nights and the rest of the history was invisible. Worse,
 * the cut landed mid-day, so the oldest date came back with only the samples
 * that happened to fit and its daily average was computed from a fragment.
 *
 * Walking to a date fixes both: we stop only once a point OLDER than the window
 * appears, which proves the window's oldest day was seen whole. `complete` says
 * whether that proof holds — false means the page ceiling cut us short and the
 * oldest date in the result may be partial.
 */
export async function listDataPoints(
  dataType: string,
  opts: {
    /** YYYY-MM-DD; walk back until a point older than this shows up */
    stopBefore?: string
    /** pull the local calendar date out of a point */
    dateOf?: (p: any) => string | null
    /** hard ceiling so a bad token can't spin forever */
    maxPages?: number
  } = {},
): Promise<{ points: any[]; complete: boolean }> {
  const { stopBefore, dateOf, maxPages = 40 } = opts
  const base = `/users/me/dataTypes/${dataType}/dataPoints`
  const points: any[] = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page++) {
    const j = await healthGet(
      `${base}?pageSize=200${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`,
    )
    const got: any[] = j.dataPoints || []
    points.push(...got)
    // a point older than the window means everything after it is older too
    if (stopBefore && dateOf) {
      for (const p of got) {
        const d = dateOf(p)
        if (d && d < stopBefore) return { points, complete: true }
      }
    }
    pageToken = j.nextPageToken
    if (!pageToken) return { points, complete: true } // ran out of history
  }
  return { points, complete: false }
}
