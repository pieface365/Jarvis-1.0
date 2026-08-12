import { GoogleGenAI, ApiError } from '@google/genai'
import { NextResponse } from 'next/server'

/**
 * POST /api/closet/identify — Google Gemini vision names + categorises a
 * clothing item. Uses the SAME free GEMINI_API_KEY as the coach route (a free
 * Google AI Studio key), so identify costs nothing — no paid Anthropic call.
 *
 * Body: { image: "data:image/jpeg;base64,..." } (client downscales to ≤768px).
 * Reply: { ok: true, item: { name, category } } where category is one of the
 *          closet's five buckets, or
 *        { ok: false, error: 'no_key' | 'bad_image' | 'too_large' |
 *          'not_clothing' | 'rate_limited' | 'api_error' }.
 *
 * The Closet tile can't call this directly (sealed tiles have an opaque origin
 * and can't reach same-origin API routes) — the dashboard host relays via the
 * tile bridge's `identifyClothing` channel.
 */

export const maxDuration = 60 // vision can take >10s; raise the serverless cap

/* must match the CATS list in public/tiles/closet.html */
const CATEGORIES = ['Tops', 'Bottoms', 'Outerwear', 'Shoes', 'Accessories'] as const

const PROMPT = `You are cataloguing a personal wardrobe. Identify the single main clothing item, pair of footwear, or accessory in this photo.
Reply with ONLY a JSON object (no markdown, no prose) of exactly this shape:
{"name": string, "category": string, "is_clothing": boolean}
- name: a short specific name — colour + material/style + garment, 2–5 words. E.g. "Black denim jacket", "White cotton tee", "Tan leather boots".
- category: the single best fit from EXACTLY this list — Tops, Bottoms, Outerwear, Shoes, Accessories.
  (Tops = shirts/tees/sweaters/hoodies; Bottoms = trousers/jeans/shorts/skirts; Outerwear = jackets/coats/blazers; Shoes = any footwear; Accessories = hats/bags/belts/watches/jewellery/scarves/sunglasses.)
- is_clothing: false if the photo does not clearly show a single wearable item.`

/** Gemini honours responseMimeType:'application/json', but strip code fences just in case. */
function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'no_key' }, { status: 503 })

  let body: { image?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_image' }, { status: 400 })
  }
  const image = typeof body?.image === 'string' ? body.image : ''
  const m = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (!m) return NextResponse.json({ ok: false, error: 'bad_image' }, { status: 400 })
  if (m[2].length > 2_800_000) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  const mimeType = 'image/' + m[1]

  const ai = new GoogleGenAI({ apiKey: key })
  const contents = [{ role: 'user', parts: [{ inlineData: { mimeType, data: m[2] } }, { text: PROMPT }] }]
  const baseConfig = { responseMimeType: 'application/json', maxOutputTokens: 1024 }
  // thinkingBudget:0 skips the model's internal reasoning pass — a wardrobe label
  // doesn't need it, and it's faster. If a model rejects a 0 budget, retry it with
  // its default (baseConfig). Model IDs get retired for new keys over time, so try
  // a few current flash models and hop on a 404, mirroring the coach route.
  const fastConfig = { ...baseConfig, thinkingConfig: { thinkingBudget: 0 } }
  const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash']

  let text = ''
  let err: unknown = null
  outer: for (const model of MODELS) {
    for (const config of [fastConfig, baseConfig]) {
      try {
        const res = await ai.models.generateContent({ model, contents, config })
        text = res.text ?? ''
        err = null
        break outer
      } catch (e) {
        err = e
        const status = e instanceof ApiError ? e.status : 0
        const msg = e instanceof Error ? e.message : ''
        if (status === 401 || status === 403 || /api[_ ]?key/i.test(msg)) {
          return NextResponse.json({ ok: false, error: 'no_key' }, { status: 401 })
        }
        if (status === 429) return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 })
        if (status === 404) continue outer // model retired for this key → next model
        // else (e.g. a 0 thinking budget this model won't take) → try baseConfig
      }
    }
  }
  if (err || !text) {
    console.error('[closet/identify] gemini error', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }

  let parsed: { name?: string; category?: string; is_clothing?: boolean }
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }
  if (parsed.is_clothing === false) {
    return NextResponse.json({ ok: false, error: 'not_clothing' }, { status: 200 })
  }
  const category = (CATEGORIES as readonly string[]).includes(parsed.category ?? '')
    ? (parsed.category as string)
    : 'Accessories'
  const name = (parsed.name ?? '').trim() || 'New item'
  return NextResponse.json({ ok: true, item: { name, category } })
}
