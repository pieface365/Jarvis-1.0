import { GoogleGenAI, ApiError } from '@google/genai'
import { NextResponse } from 'next/server'

/**
 * POST /api/school/import — Google Gemini vision reads one or more screenshots of
 * a course syllabus / class schedule and extracts a structured plan: the class
 * name, every dated lecture, and the quiz / exam / assignment dates. Uses the
 * SAME free GEMINI_API_KEY as the other AI features.
 *
 * Body:  { images: ["data:image/png;base64,...", ...] }  (1–8 pages of ONE class)
 * Reply: { ok: true, syllabus: {
 *            className, lectures:[{title,date}], quizzes:[{title,date}],
 *            exams:[{title,date}], assignments:[{title,date}] } }   dates ISO YYYY-MM-DD
 *        or { ok: false, error: 'no_key' | 'bad_image' | 'too_large' |
 *            'rate_limited' | 'api_error' }.
 *
 * The School tile can't call this directly (sealed tiles have an opaque origin) —
 * the dashboard host relays via the tile bridge's `importSyllabus` channel.
 */

export const maxDuration = 60 // multi-image vision extraction can take >15s

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')
/** Keep only well-formed YYYY-MM-DD dates. */
function cleanDate(v: unknown): string {
  const s = asStr(v).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}
function cleanEntries(v: unknown, cap: number): Array<{ title: string; date: string }> {
  return asArr(v)
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      return { title: asStr(o.title).slice(0, 160).trim(), date: cleanDate(o.date) }
    })
    .filter((e) => e.title && e.date)
    .slice(0, cap)
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'no_key' }, { status: 503 })

  let body: { images?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_image' }, { status: 400 })
  }
  const rawImages = asArr(body?.images).filter((x): x is string => typeof x === 'string').slice(0, 8)
  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = []
  for (const img of rawImages) {
    const m = img.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
    if (!m) continue
    if (m[2].length > 2_800_000) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
    parts.push({ inlineData: { mimeType: 'image/' + m[1], data: m[2] } })
  }
  if (parts.length === 0) return NextResponse.json({ ok: false, error: 'bad_image' }, { status: 400 })

  const hintYear = new Date().getFullYear()
  const PROMPT = `You are reading screenshot(s) of ONE university course's syllabus / class schedule. The images may be multiple pages of the same course — treat them together as a single class.

Extract, as accurately as possible:
- className: the course/class name from the title or header (e.g. "Gerontology", "GI Hepatic and Nutrition").
- lectures: every scheduled teaching session that has a date and a topic. Use the row's topic as the title; if one date lists several topics, join them with " / ". EXCLUDE rows that are exams, quizzes-only, or "No class"/holiday rows.
- quizzes: every explicitly labelled quiz, with the date of the class it falls on. title like "Quiz 1" (keep the number if given).
- exams: every exam, midterm, final, or OSCE, with its date. title like "Exam 1", "Midterm", "Final Exam", "OSCE 1".
- assignments: any item with an explicit DUE date (e.g. "Due Sunday 9/13"), with that due date. title = the assignment name (or "Assignment" if unnamed).

Dates: output ISO "YYYY-MM-DD". If a row prints a year (e.g. 10/1/26 or "Date (2026)"), use it. If NO year is shown, assume the year is ${hintYear}. A date like "9/1", "Sept 1", or "Thurs 10/1" with no year → use ${hintYear}. Watch for obvious typos (e.g. one row saying /25 while every other row is /26 → treat as /26).

Reply with ONLY a JSON object — no markdown, no prose — of exactly this shape:
{"className": string,
 "lectures": [{"title": string, "date": string}],
 "quizzes": [{"title": string, "date": string}],
 "exams": [{"title": string, "date": string}],
 "assignments": [{"title": string, "date": string}]}
Any category with nothing found is an empty array. Do not invent dates you cannot see.`
  parts.push({ text: PROMPT })

  const ai = new GoogleGenAI({ apiKey: key })
  const contents = [{ role: 'user', parts }]
  const config = { responseMimeType: 'application/json', maxOutputTokens: 8192 }
  const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest']

  let text = ''
  let err: unknown = null
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({ model, contents, config })
      text = res.text ?? ''
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
      // 404 (model retired) → try the next model
    }
  }
  if (err || !text) {
    console.error('[school/import] gemini error', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }

  let parsed: {
    className?: unknown
    lectures?: unknown
    quizzes?: unknown
    exams?: unknown
    assignments?: unknown
  }
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return NextResponse.json({ ok: false, error: 'api_error' }, { status: 502 })
  }

  const syllabus = {
    className: asStr(parsed.className).slice(0, 80).trim() || 'Class',
    lectures: cleanEntries(parsed.lectures, 60),
    quizzes: cleanEntries(parsed.quizzes, 40),
    exams: cleanEntries(parsed.exams, 20),
    assignments: cleanEntries(parsed.assignments, 40),
  }
  return NextResponse.json({ ok: true, syllabus })
}
