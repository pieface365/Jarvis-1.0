import { NextResponse } from 'next/server'
import { supa } from '@/lib/tiles/tileSupabase'
import { constantTimeEquals } from '@/app/api/mcp/oauth/crypto'

/**
 * GET /api/widget — a tiny read-only summary for an iOS Lock Screen widget
 * (rendered by the Scriptable app; see docs/lock-screen-widget.md).
 *
 * Auth: a bearer token (`Authorization: Bearer <WIDGET_TOKEN>` or `?token=`),
 * NOT the browser gate cookie — a Lock Screen widget can't carry the cookie, so
 * middleware lets /api/widget through and this route does its own token check.
 * Returns 503 until WIDGET_TOKEN is set, exactly like the MCP connector.
 *
 * Reads the same Supabase `tile_data` rows the tiles sync to and distils them
 * into the few numbers a widget can show: recovery/HRV/RHR/sleep (latest vitals
 * day), today's calories + protein vs. goal, and today's training session. The
 * training split is a fixed weekly program (mirrors public/tiles/train.html), so
 * it needs no data read.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Row = { tile_id: string; data: unknown; updated_at: string | null }
type Obj = Record<string, unknown>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/* ── auth ───────────────────────────────────────────────────────────────── */

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  if (m) return m[1].trim()
  const t = new URL(req.url).searchParams.get('token')
  return t ? t.trim() : null
}

/* ── tile_data selection (mirrors app/api/coach/route.ts) ───────────────── */

/** The saved blob for a slot: prefer the bare `train`/`fuel`/… row, else the
 *  newest `<userId>:<slot>` write. */
function pickSlot(rows: Row[], slot: string): Obj | null {
  const match = rows
    .filter((r) => r.tile_id === slot || r.tile_id.endsWith(':' + slot))
    .sort((a, b) => {
      if ((a.tile_id === slot) !== (b.tile_id === slot)) return a.tile_id === slot ? -1 : 1
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    })[0]?.data
  return match && typeof match === 'object' && !Array.isArray(match) ? (match as Obj) : null
}

/* ── vitals: recovery estimate (same weighting as public/tiles/vitals.html) ─ */

const FEEL_REC: Record<number, number> = { 1: 20, 2: 50, 3: 75, 4: 95 }
const FEEL_SLEEP_ADJ: Record<number, number> = { 1: -10, 2: 0, 3: 4, 4: 8 }

function adjSleepPerf(h: Obj): number | null {
  const p = num(h.sleepPerf)
  if (p == null) return null
  const a = typeof h.feel === 'number' ? FEEL_SLEEP_ADJ[h.feel] ?? 0 : 0
  return Math.max(1, Math.min(100, Math.round(p + a)))
}

function estRecovery(h: Obj): number | null {
  const parts: number[] = []
  const w: number[] = []
  const hrv = num(h.hrv)
  const rhr = num(h.rhr)
  const sh = num(h.sleepHours)
  if (hrv != null) { parts.push(clamp01((hrv - 20) / (90 - 20)) * 100); w.push(0.5) }
  if (rhr != null) { parts.push(clamp01((80 - rhr) / (80 - 42)) * 100); w.push(0.25) }
  const sp = adjSleepPerf(h)
  if (sp != null) { parts.push(sp); w.push(0.25) }
  else if (sh != null) { parts.push(clamp01(sh / 8) * 100); w.push(0.25) }
  if (typeof h.feel === 'number') { parts.push(FEEL_REC[h.feel] ?? 50); w.push(0.3) }
  if (!parts.length) return null
  const sw = w.reduce((a, b) => a + b, 0)
  let s = 0
  for (let i = 0; i < parts.length; i++) s += parts[i] * w[i]
  return Math.max(1, Math.min(99, Math.round(s / sw)))
}

/** The most recently dated vitals entry, with a derived recovery %. */
function latestVitals(store: Obj | null) {
  if (!store) return null
  const key = Object.keys(store)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .pop()
  const e = key ? store[key] : null
  if (!key || !e || typeof e !== 'object') return null
  const h = e as Obj
  return { date: key, hrv: num(h.hrv), rhr: num(h.rhr), sleepHours: num(h.sleepHours), recovery: estRecovery(h) }
}

/* ── fuel: today's totals vs. goal ──────────────────────────────────────── */

function todayKeyIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function fuelToday(store: Obj | null, tz: string) {
  const calGoal = num(store?.goalCal) ?? 2400 // PLAN_TARGET.cal fallback
  const proteinGoal = num(store?.goalProtein) ?? 150 // PLAN_TARGET.p fallback
  const log = store && Array.isArray(store[todayKeyIn(tz)]) ? (store[todayKeyIn(tz)] as Obj[]) : []
  let cal = 0
  let protein = 0
  for (const e of log) {
    cal += Number(e?.cal) || 0
    protein += Number(e?.p) || 0
  }
  return { cal: Math.round(cal), calGoal, protein: Math.round(protein), proteinGoal }
}

/* ── training: the fixed weekly split (mirrors PROGRAM in train.html) ────── */

const WORKOUT: Record<string, { type: string; label: string }> = {
  Mon: { type: 'Climb', label: 'Climb · Limit' },
  Tue: { type: 'Lift', label: 'Lift · Push' },
  Wed: { type: 'Climb', label: 'Climb · Technique' },
  Thu: { type: 'Lift', label: 'Lift · Legs' },
  Fri: { type: 'Climb', label: 'Climb · Projecting' },
  Sat: { type: 'Lift', label: 'Lift · Pull' },
  Sun: { type: 'Rest', label: 'Rest' },
}

function workoutToday(tz: string) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date())
  return { day, ...(WORKOUT[day] ?? { type: '—', label: '—' }) }
}

/* ── handler ────────────────────────────────────────────────────────────── */

export async function GET(req: Request) {
  const expected = process.env.WIDGET_TOKEN
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'not_configured', hint: 'Set WIDGET_TOKEN in the environment.' }, { status: 503 })
  }
  const provided = bearer(req)
  if (!provided || !constantTimeEquals(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const tz = new URL(req.url).searchParams.get('tz') || 'America/New_York'
  const db = supa()
  if (!db) return NextResponse.json({ ok: false, error: 'no_db' }, { status: 503 })

  let rows: Row[] = []
  try {
    const { data, error } = await db.from('tile_data').select('tile_id, data, updated_at')
    if (error || !data) return NextResponse.json({ ok: false, error: 'read_failed' }, { status: 502 })
    rows = data as Row[]
  } catch {
    return NextResponse.json({ ok: false, error: 'read_failed' }, { status: 502 })
  }

  const vitals = latestVitals(pickSlot(rows, 'vitals'))
  const fuel = fuelToday(pickSlot(rows, 'fuel'), tz)
  const workout = workoutToday(tz)

  return NextResponse.json(
    {
      ok: true,
      asOf: new Date().toISOString(),
      tz,
      vitalsDate: vitals?.date ?? null,
      recovery: vitals?.recovery ?? null,
      hrv: vitals?.hrv ?? null,
      rhr: vitals?.rhr ?? null,
      sleepHours: vitals?.sleepHours ?? null,
      fuel,
      workout,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
