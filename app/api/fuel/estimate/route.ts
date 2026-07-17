import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

/**
 * POST /api/fuel/estimate — Claude vision estimates the macros of a plate.
 *
 * Body: { image: "data:image/jpeg;base64,..." } (client downscales to ≤1024px).
 * Reply: { ok: true, est: { name, portion_grams, cal, protein_g, carbs_g,
 *          fat_g, confidence, notes } } for the WHOLE visible portion, or
 *        { ok: false, error: 'no_key' | 'bad_image' | 'too_large' | 'rate_limited' | 'api_error' }.
 *
 * The Fuel tile can't call this directly (sealed tiles have an opaque origin,
 * so the gate cookie wouldn't ride along) — the dashboard host relays via the
 * tile bridge's `estimateFood` channel. Requires ANTHROPIC_API_KEY.
 */

export const maxDuration = 60 // Claude vision can take >10s; raise the serverless cap

const MEDIA: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/* strict JSON schema so the reply is guaranteed parseable (numeric range
   constraints aren't supported in structured outputs — sanity-check instead) */
const EST_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short dish name, e.g. "Chicken burrito bowl"' },
    portion_grams: { type: 'integer', description: 'Estimated weight in grams of the entire visible edible portion' },
    cal: { type: 'number', description: 'Calories in the entire visible portion' },
    protein_g: { type: 'number', description: 'Protein grams in the entire visible portion' },
    carbs_g: { type: 'number', description: 'Carbohydrate grams in the entire visible portion' },
    fat_g: { type: 'number', description: 'Fat grams in the entire visible portion' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string', description: 'One short sentence on the key assumptions (e.g. dressing, cooking oil)' },
  },
  required: ['name', 'portion_grams', 'cal', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'notes'],
  additionalProperties: false,
} as const

const PROMPT = `Estimate the nutrition of the food in this photo for a personal food log.
Estimate the ENTIRE edible portion visible (not per 100g). Use typical preparation
assumptions (cooking oil, dressings) and note them. If multiple items share the
plate, sum them into one estimate and name the dish accordingly. Be realistic
rather than optimistic about portion size.`

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY
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

  const client = new Anthropic({ apiKey: key })
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low', // a quick portion estimate, not a research task
        format: { type: 'json_schema', schema: EST_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: MEDIA[m[1]], data: m[2] } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    })
    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const est = JSON.parse(text)
    return NextResponse.json({ ok: true, est })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 })
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
    }
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 500 })
  }
}
