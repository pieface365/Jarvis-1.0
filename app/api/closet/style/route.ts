import { GoogleGenAI, ApiError } from '@google/genai'
import { NextResponse } from 'next/server'

/**
 * POST /api/closet/style — the Closet stylist. Google Gemini, grounded with live
 * Google Search, builds outfit combinations from the clothes the user actually
 * owns and suggests "what to buy next" gaps, factoring in current fashion trends.
 * Uses the SAME free GEMINI_API_KEY as the other AI features.
 *
 * Body: { items: [{ name, cat }], context?: string }  (context = optional
 *        occasion/weather, e.g. "date night" or "cold and rainy")
 * Reply: { ok: true, style: { outfits: [{ title, occasion, items[], why }],
 *          gaps: [{ item, why }], note }, sources: [{ title, uri }] }
 *        or { ok: false, error: 'no_key' | 'empty_closet' | 'rate_limited' |
 *          'bad_request' | 'api_error' }.
 *
 * The Closet tile can't call this directly (opaque origin) — the dashboard host
 * relays via the tile bridge's `styleCloset` channel.
 */

export const maxDuration = 60 // grounded generation can take >15s

type Item = { name: string; cat: string }

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}
/** Parse the model's reply as JSON, tolerating stray prose around the object. */
function extractJson(s: string): unknown {
  const t = stripFences(s)
  try {
    return JSON.parse(t)
  } catch {
    const i = t.indexOf('{'),
      j = t.lastIndexOf('}')
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1))
      } catch {
        /* fall through */
      }
    }
    return null
  }
}

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'no_key' }, { status: 503 })

  let body: { items?: unknown; context?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 })
  }
  const items: Item[] = asArr(body?.items)
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>
      return { name: asStr(o.name).slice(0, 120), cat: asStr(o.cat).slice(0, 40) }
    })
    .filter((it) => it.name)
    .slice(0, 200)
  if (items.length === 0) return NextResponse.json({ ok: false, error: 'empty_closet' }, { status: 200 })
  const context = asStr(body?.context).slice(0, 200).trim()

  const byCat: Record<string, string[]> = {}
  for (const it of items) (byCat[it.cat] || (byCat[it.cat] = [])).push(it.name)
  const wardrobe = Object.entries(byCat)
    .map(([cat, names]) => `${cat || 'Other'}: ${names.join(', ')}`)
    .join('\n')

  const prompt = `You are a sharp personal fashion stylist. The user owns EXACTLY these wardrobe items, grouped by category:
${wardrobe}
${context ? `\nStyling context to honour: ${context}\n` : ''}
First, search the web for current (this season) fashion trends, colour stories, and outfit ideas that are relevant to this specific wardrobe. Then:
1. Build 3–4 complete, wearable outfit combinations using ONLY the items listed above — reference each piece by its EXACT name as written. Combine categories sensibly (typically a top + a bottom + footwear, plus optional outerwear/accessory). Give each outfit a short vibe/occasion label and a one-line reason grounded in what's current.
2. Suggest 3–5 "gaps": specific pieces the user does NOT already own that would unlock the most new outfits or modernise the wardrobe most — each with a one-line why.

Reply with ONLY a JSON object — no markdown fences, no prose before or after — of exactly this shape:
{"outfits":[{"title":string,"occasion":string,"items":string[],"why":string}],"gaps":[{"item":string,"why":string}],"note":string}
Rules:
- Every string in each outfit's "items" MUST be one of the owned item names above, copied exactly.
- "note" is one short sentence on the overall trend direction you leaned on.
- Keep every "why" to a single concise sentence.`

  const ai = new GoogleGenAI({ apiKey: key })
  const contents = [{ role: 'user', parts: [{ text: prompt }] }]
  // Google Search grounding: the model searches live and cites sources, which we
  // pass back so the tile can link them. Tools + responseMimeType JSON don't mix,
  // so we ask for JSON in the prompt and parse defensively. Model IDs get retired
  // for new keys over time, so try a few and hop on failure — like the coach route.
  const config = { tools: [{ googleSearch: {} }], maxOutputTokens: 8192 }
  const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest']

  let text = ''
  let sources: Array<{ title: string; uri: string }> = []
  let err: unknown = null
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({ model, contents, config })
      text = res.text ?? ''
      const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
      const seen = new Set<string>()
      for (const c of chunks) {
        const uri = c.web?.uri
        if (uri && !seen.has(uri)) {
          seen.add(uri)
          sources.push({ title: (c.web?.title || uri).slice(0, 140), uri })
          if (sources.length >= 6) break
        }
      }
      err = null
      break
    } catch (e) {
      err = e
      const status = e instanceof ApiError ? e.status : 0
      const msg = e instanceof Error ? e.message : ''
      if (status === 401 || status === 403 || /api[_ ]?key/i.test(msg)) {
        return NextResponse.json({ ok: false, error: 'no_key' }, { status: 401 })
      }
      if (status === 429) return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 })
      // 404 (model retired) or a tool-unsupported 400 → try the next model
    }
  }
  if (err || !text) {
    console.error('[closet/style] gemini error', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }

  const parsed = extractJson(text) as
    | { outfits?: unknown; gaps?: unknown; note?: unknown }
    | null
  if (!parsed) return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })

  const owned = new Set(items.map((it) => it.name.toLowerCase()))
  const outfits = asArr(parsed.outfits)
    .map((o) => {
      const r = (o ?? {}) as Record<string, unknown>
      return {
        title: asStr(r.title).slice(0, 80) || 'Outfit',
        occasion: asStr(r.occasion).slice(0, 80),
        items: asArr(r.items)
          .map(asStr)
          .filter((n) => owned.has(n.toLowerCase())) // keep only pieces they own
          .slice(0, 8),
        why: asStr(r.why).slice(0, 300),
      }
    })
    .filter((o) => o.items.length > 0)
    .slice(0, 6)
  const gaps = asArr(parsed.gaps)
    .map((g) => {
      const r = (g ?? {}) as Record<string, unknown>
      return { item: asStr(r.item).slice(0, 80), why: asStr(r.why).slice(0, 300) }
    })
    .filter((g) => g.item)
    .slice(0, 6)
  const note = asStr(parsed.note).slice(0, 400)

  if (outfits.length === 0 && gaps.length === 0) {
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, style: { outfits, gaps, note }, sources })
}
