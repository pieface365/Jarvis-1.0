import { GoogleGenAI, ApiError } from '@google/genai'
import { NextResponse } from 'next/server'

/**
 * POST /api/fuel/estimate — Google Gemini vision estimates the macros of a plate.
 *
 * Uses the SAME free GEMINI_API_KEY as the coach and the closet identify routes
 * (a free Google AI Studio key), so plate estimates cost nothing — no paid
 * Anthropic call.
 *
 * Body: { image: "data:image/jpeg;base64,..." } (client downscales to ≤1024px).
 * Reply: { ok: true, est: { name, portion_grams, cal, protein_g, carbs_g,
 *          fat_g, confidence, notes } } for the WHOLE visible portion, or
 *        { ok: false, error: 'no_key' | 'bad_image' | 'too_large' | 'rate_limited' | 'api_error' }.
 *
 * The Fuel tile can't call this directly (sealed tiles have an opaque origin
 * and can't reach same-origin API routes) — the dashboard host relays via the
 * tile bridge's `estimateFood` channel.
 */

export const maxDuration = 60 // vision can take >10s; raise the serverless cap

const PROMPT = `Estimate the nutrition of the food in this photo for a personal food log.
Estimate the ENTIRE edible portion visible (not per 100g). Use typical preparation
assumptions (cooking oil, dressings) and note them. If multiple items share the
plate, sum them into one estimate and name the dish accordingly. Be realistic
rather than optimistic about portion size.
Reply with ONLY a JSON object (no markdown, no prose) of exactly this shape:
{"name": string, "portion_grams": number, "cal": number, "protein_g": number, "carbs_g": number, "fat_g": number, "confidence": "low"|"medium"|"high", "notes": string}
- name: short dish name, e.g. "Chicken burrito bowl".
- portion_grams: estimated weight in grams of the entire visible edible portion.
- cal / protein_g / carbs_g / fat_g: totals for that entire portion.
- confidence: your confidence in the estimate.
- notes: one short sentence on the key assumptions (e.g. dressing, cooking oil).`

/** Gemini honours responseMimeType:'application/json', but strip code fences just in case. */
function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
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
  // thinkingBudget:0 skips the model's internal reasoning pass for speed; if a
  // model rejects a 0 budget, retry it with its default. Model IDs get retired
  // for new keys over time, so try a few flash models and hop on a 404 — same
  // pattern as the coach and closet routes.
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
    console.error('[fuel/estimate] gemini error', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }
  const conf = parsed.confidence
  const est = {
    name: String(parsed.name ?? '').trim() || 'Meal',
    portion_grams: Math.max(0, Math.round(num(parsed.portion_grams))),
    cal: Math.max(0, num(parsed.cal)),
    protein_g: Math.max(0, num(parsed.protein_g)),
    carbs_g: Math.max(0, num(parsed.carbs_g)),
    fat_g: Math.max(0, num(parsed.fat_g)),
    confidence: conf === 'low' || conf === 'high' ? conf : 'medium',
    notes: String(parsed.notes ?? '').trim(),
  }
  return NextResponse.json({ ok: true, est })
}
