import { GoogleGenAI, ApiError } from '@google/genai'
import { NextResponse } from 'next/server'
import { supa } from '@/lib/tiles/tileSupabase'

/**
 * POST /api/coach — the dashboard's AI coach, powered by Google Gemini.
 *
 * Body: { messages: [{ role: 'user'|'assistant', text }], tz?: 'America/…' }
 * Reply: an NDJSON stream, one JSON object per line:
 *   { t:'text',  v:'…' }            a chunk of the answer
 *   { t:'done' }                    the answer finished cleanly
 *   { t:'error', v:'no_key'|'api_error'|'rate_limited' }
 *
 * Before calling the model it reads the owner's tile data (train / fuel /
 * vitals / peak) straight from Supabase — the same rows the tiles sync to —
 * prunes it to the recent window, and hands it over as context. Dashboard-only:
 * it answers from that data plus the model's own knowledge, no live web search
 * (Gemini's free tier keeps this fully free). Sits behind the middleware gate
 * like every other API route. Requires GEMINI_API_KEY (a free Google AI Studio
 * key — the { t:'status' } and { t:'sources' } stream events the client still
 * understands simply never fire without web search).
 */

export const maxDuration = 60 // streamed answer over the free-tier rate limit

const SLOTS = ['train', 'fuel', 'vitals', 'peak'] as const

type ChatMsg = { role: 'user' | 'assistant'; text: string }

/* ── dashboard context ──────────────────────────────────────────────────── */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const RECENT_DAYS = 45

function daysAgo(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return Math.round((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000)
}

/**
 * Shrink a tile's saved blob to something prompt-sized without knowing its
 * schema: drop embedded images (the physique photo log is megabytes of data
 * URLs), drop date-keyed entries older than the recent window, cap runaway
 * arrays and strings.
 */
function prune(v: unknown, depth = 0): unknown {
  if (depth > 8) return '…'
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v
  if (Array.isArray(v)) return (v.length > 30 ? v.slice(-30) : v).map((x) => prune(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (/photo|image|img|base64|thumb/i.test(k)) continue
      if (DATE_KEY.test(k) && daysAgo(k) > RECENT_DAYS) continue
      out[k] = prune(val, depth + 1)
    }
    return out
  }
  return v
}

/**
 * Read every slot's saved data from the owner's Supabase. Slot tiles sync
 * under the bare slot id (`train`, `fuel`, …) via lib/sync; older writes land
 * under `<userId>:<slot>` via tileStore — prefer bare, else the newest match.
 */
async function dashboardContext(): Promise<string> {
  const db = supa()
  if (!db) return 'Dashboard data is unavailable (Supabase sync is not configured on this deployment).'
  let rows: Array<{ tile_id: string; data: unknown; updated_at: string | null }> = []
  try {
    const { data, error } = await db.from('tile_data').select('tile_id, data, updated_at')
    if (error || !data) return 'Dashboard data could not be read right now.'
    rows = data
  } catch {
    return 'Dashboard data could not be read right now.'
  }
  const parts: string[] = []
  for (const slot of SLOTS) {
    const matches = rows
      .filter((r) => r.tile_id === slot || r.tile_id.endsWith(':' + slot))
      .sort((a, b) => {
        if ((a.tile_id === slot) !== (b.tile_id === slot)) return a.tile_id === slot ? -1 : 1
        return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      })
    const row = matches[0]
    if (!row || row.data == null) {
      parts.push(`## ${slot}\n(no data)`)
      continue
    }
    let json = JSON.stringify(prune(row.data))
    if (json.length > 60_000) json = json.slice(0, 60_000) + '…[truncated]'
    parts.push(`## ${slot}\n${json}`)
  }
  return parts.join('\n\n')
}

/* ── the request ────────────────────────────────────────────────────────── */

function systemPrompt(tz: string | undefined, context: string): string {
  let now: string
  try {
    now = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date())
  } catch {
    now = new Date().toUTCString()
  }
  return `You are Coach, the AI coach built into Vitality — the owner's personal health dashboard. You are talking to the dashboard's owner about their training, climbing, nutrition, sleep, recovery, and caffeine.

For the owner it is now: ${now}.

Below is the owner's actual dashboard data, as saved by their tiles (recent window, pruned):
- "train": strength training program, per-exercise logs (kg/lb × reps), goals, bodyweight log
- "fuel": food log per day (name, grams, calories, protein/carbs/fat) and the nutrition plan
- "vitals": daily HRV, resting HR, sleep hours, recovery %, subjective feel, weight
- "peak": wake/bed schedule and the caffeine log (dose mg at time t, hours as decimals)

<dashboard_data>
${context}
</dashboard_data>

Ground every answer in this data when it is relevant — quote their real numbers and dates rather than speaking generically. If the data doesn't cover something, say so plainly. You can't browse the web, so for outside facts rely on your own training knowledge and say when you're unsure rather than inventing specifics. Answer directly and concisely, like a sharp coach who has read the training log — lead with the recommendation, then the reasoning. Use plain prose with occasional short "- " bullet lists; **bold** for key numbers or the headline recommendation; no headers or tables. You are not a doctor — for red-flag symptoms, say to see a professional, briefly and without lecturing.`
}

/** Dig the human-readable message out of a Gemini SDK error. The SDK stuffs the
 *  raw API response — often JSON nested one or two levels deep — into
 *  err.message; pull out the innermost `.error.message` so the owner sees
 *  "API key not valid" rather than a wall of escaped JSON. */
function geminiMessage(err: unknown): string {
  let s = err instanceof Error ? err.message : String(err)
  for (let i = 0; i < 3; i++) {
    try {
      const o = JSON.parse(s) as { error?: { message?: string }; message?: string }
      const inner = o?.error?.message ?? o?.message
      if (typeof inner === 'string' && inner !== s) {
        s = inner
        continue
      }
    } catch {
      /* not JSON — s is already the plain message */
    }
    break
  }
  return s.slice(0, 300)
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'no_key' }, { status: 503 })

  let body: { messages?: unknown; tz?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 })
  }
  const raw = Array.isArray(body?.messages) ? (body.messages as unknown[]) : []
  const cleaned: ChatMsg[] = raw
    .filter(
      (m): m is ChatMsg =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatMsg).role === 'user' || (m as ChatMsg).role === 'assistant') &&
        typeof (m as ChatMsg).text === 'string' &&
        (m as ChatMsg).text.trim() !== '',
    )
    .slice(-24)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 8000) }))

  /* Collapse consecutive same-role turns into one. A client whose transcript
     lost a reply (panel closed mid-answer, a storage write that failed) would
     otherwise send e.g. [user, user], which is not a well-formed conversation.
     Merging keeps every question intact instead of rejecting the request. */
  const messages: ChatMsg[] = []
  for (const m of cleaned) {
    const prev = messages[messages.length - 1]
    if (prev && prev.role === m.role) prev.text += '\n\n' + m.text
    else messages.push({ ...m })
  }
  // a conversation must begin with the user's turn
  while (messages.length && messages[0].role !== 'user') messages.shift()

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 })
  }
  const tz = typeof body.tz === 'string' ? body.tz : undefined

  const context = await dashboardContext()
  const ai = new GoogleGenAI({ apiKey: key })
  // let the client's ReadableStream.cancel() abort the upstream call
  const ac = new AbortController()

  // Gemini's roles are 'user' / 'model'; our transcript uses 'assistant'.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }))
  const config = {
    systemInstruction: systemPrompt(tz, context),
    maxOutputTokens: 2048,
    abortSignal: ac.signal,
  }

  const enc = new TextEncoder()
  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (o: object) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      let emitted = false // once any text has streamed we're committed to that model
      let err: unknown = null
      // Try current models in order and use whichever this account can reach —
      // Google retires model IDs for new users over time (a hardcoded one 404s),
      // so `-latest` first (auto-current), then concrete fallbacks. Only hop to
      // the next on a clean 404 before any text; other errors (bad key, rate
      // limit) are real and reported as-is.
      const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
      for (const model of MODELS) {
        try {
          const stream = await ai.models.generateContentStream({ model, contents, config })
          for await (const chunk of stream) {
            const text = chunk.text
            if (text) {
              emitted = true
              push({ t: 'text', v: text })
            }
          }
          err = null
          break
        } catch (e) {
          err = e
          const notFound = e instanceof ApiError && e.status === 404
          if (emitted || !notFound) break // real failure, or already mid-answer
        }
      }
      if (!err) {
        push({ t: 'done' })
      } else {
        // 429 = free-tier rate/quota limit; everything else is a generic failure
        const rate = err instanceof ApiError && err.status === 429
        // Surface the real reason: Gemini's errors are specific (bad key, model
        // not found, API not enabled, key restricted) and the generic line hides
        // exactly what to fix. `d` is shown to the owner and logged server-side.
        const status = err instanceof ApiError ? err.status : undefined
        const detail = geminiMessage(err)
        console.error('[coach] gemini error', status, err instanceof Error ? err.message : err)
        push({ t: 'error', v: rate ? 'rate_limited' : 'api_error', d: (status ? status + ' · ' : '') + detail })
      }
      controller.close()
    },
    cancel() {
      ac.abort()
    },
  })
  return new Response(rs, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
