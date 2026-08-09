import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

/**
 * POST /api/closet/identify — Claude vision names + categorises a clothing item.
 *
 * Body: { image: "data:image/jpeg;base64,..." } (client downscales to ≤768px).
 * Reply: { ok: true, item: { name, category } } where category is one of the
 *          closet's five buckets, or
 *        { ok: false, error: 'no_key' | 'bad_image' | 'too_large' |
 *          'not_clothing' | 'rate_limited' | 'api_error' }.
 *
 * The Closet tile can't call this directly (sealed tiles have an opaque origin,
 * so the gate cookie wouldn't ride along) — the dashboard host relays via the
 * tile bridge's `identifyClothing` channel. Requires ANTHROPIC_API_KEY.
 * Mirrors /api/fuel/estimate.
 */

export const maxDuration = 60 // Claude vision can take >10s; raise the serverless cap

const MEDIA: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/* must match the CATS list in public/tiles/closet.html */
const CATEGORIES = ['Tops', 'Bottoms', 'Outerwear', 'Shoes', 'Accessories'] as const

const ID_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Short specific name of the item — colour + material/style + garment, 2–5 words. E.g. "Black denim jacket", "White cotton tee", "Tan leather boots".',
    },
    category: { type: 'string', enum: [...CATEGORIES] },
    is_clothing: {
      type: 'boolean',
      description: 'true only if the photo clearly shows a wearable clothing item, footwear, or accessory',
    },
  },
  required: ['name', 'category', 'is_clothing'],
  additionalProperties: false,
} as const

const PROMPT = `Identify the single main clothing item, pair of footwear, or accessory in this photo for a personal wardrobe catalog.
Give it a short specific name (colour + material/style + garment, 2–5 words) and pick the best-fitting category from the allowed list.
Category guide: Tops = shirts, tees, sweaters, hoodies; Bottoms = trousers, jeans, shorts, skirts; Outerwear = jackets, coats, blazers; Shoes = any footwear; Accessories = hats, bags, belts, watches, jewellery, scarves, sunglasses.
If the photo does not clearly show a single wearable item, set is_clothing to false.`

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
        effort: 'low', // a quick label, not a research task
        format: { type: 'json_schema', schema: ID_SCHEMA as unknown as Record<string, unknown> },
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
    const parsed = JSON.parse(text) as { name?: string; category?: string; is_clothing?: boolean }
    if (!parsed.is_clothing) {
      return NextResponse.json({ ok: false, error: 'not_clothing' }, { status: 200 })
    }
    const category = (CATEGORIES as readonly string[]).includes(parsed.category ?? '')
      ? (parsed.category as string)
      : 'Accessories'
    const name = (parsed.name ?? '').trim() || 'New item'
    return NextResponse.json({ ok: true, item: { name, category } })
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
