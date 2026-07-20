import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { supa } from '@/lib/tiles/tileSupabase'

/**
 * POST /api/coach — the dashboard's AI coach.
 *
 * Body: { messages: [{ role: 'user'|'assistant', text }], tz?: 'America/…' }
 * Reply: an NDJSON stream, one JSON object per line:
 *   { t:'status', v:'searching' }   Claude is running a web search
 *   { t:'text',   v:'…' }           a chunk of the answer
 *   { t:'sources', v:[{url,title}] } web citations, once, before done
 *   { t:'done' }                    the answer finished cleanly
 *   { t:'error', v:'no_key'|'api_error'|'rate_limited' }
 *
 * Before calling Claude it reads the owner's tile data (train / fuel / vitals /
 * peak) straight from Supabase — the same rows the tiles sync to — prunes it to
 * the recent window, and hands it to the model as context, with the web-search
 * server tool enabled for anything the dashboard can't answer. Sits behind the
 * middleware gate like every other API route. Requires ANTHROPIC_API_KEY.
 */

export const maxDuration = 60 // streamed answer + a few web searches

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

Ground every answer in this data when it is relevant — quote their real numbers and dates rather than speaking generically. If the data doesn't cover something, say so plainly. Use web search when a question needs outside or current information (research, technique, products, weather, events); cite what you find. Answer directly and concisely, like a sharp coach who has read the training log — lead with the recommendation, then the reasoning. Use plain prose with occasional short "- " bullet lists; **bold** for key numbers or the headline recommendation; no headers or tables. You are not a doctor — for red-flag symptoms, say to see a professional, briefly and without lecturing.`
}

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY
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
  const client = new Anthropic({ apiKey: key })
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: systemPrompt(tz, context),
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    messages: messages.map((m) => ({ role: m.role, content: m.text })),
  })

  const enc = new TextEncoder()
  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (o: object) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      const sources: Array<{ url: string; title: string | null }> = []
      try {
        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') {
            push({ t: 'status', v: 'searching' })
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta
            if (d.type === 'text_delta') push({ t: 'text', v: d.text })
            else if (d.type === 'citations_delta') {
              const c = d.citation
              if (c.type === 'web_search_result_location' && !sources.some((s) => s.url === c.url)) {
                sources.push({ url: c.url, title: c.title })
              }
            }
          }
        }
        if (sources.length) push({ t: 'sources', v: sources.slice(0, 8) })
        push({ t: 'done' })
      } catch (err) {
        push({ t: 'error', v: err instanceof Anthropic.RateLimitError ? 'rate_limited' : 'api_error' })
      }
      controller.close()
    },
    cancel() {
      stream.abort()
    },
  })
  return new Response(rs, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
