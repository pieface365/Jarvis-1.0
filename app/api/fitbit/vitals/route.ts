import { NextResponse } from 'next/server'
import { getAccessToken, listDataPoints } from '@/lib/fitbit/server'

/**
 * GET /api/fitbit/vitals?days=14 → { connected, days: { 'YYYY-MM-DD':
 * { hrv, rhr, sleepHours, sleepPerf } }, errors: [] }
 *
 * Data comes from the Google Health API (Fitbit's replacement): the `sleep`,
 * `heart-rate-variability`, and `daily-resting-heart-rate` data types. The
 * shape matches the Vitals tile's store exactly so the dashboard merges it
 * straight in.
 *
 * Quirks handled here: proto int64s arrive as JSON *strings* ("580"), times
 * are UTC + a utcOffset (no civil fields), and there's no efficiency field —
 * sleepPerf is computed as minutesAsleep / minutesInSleepPeriod, which is the
 * classic sleep-efficiency definition (Fitbit's app-only score isn't exposed).
 */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

type Entry = { hrv?: number; rhr?: number; sleepHours?: number; sleepPerf?: number }

/** The data union appears either directly on the point or under .data. */
const payload = (p: any, key: string) => p?.[key] ?? p?.data?.[key]

/** Local calendar date of a UTC instant given the API's "-14400s" offset. */
function localDate(utcIso?: string, utcOffset?: string): string | null {
  if (!utcIso) return null
  const off = parseInt(utcOffset || '0', 10) || 0
  const d = new Date(new Date(utcIso).getTime() + off * 1000)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null
}

/** First YYYY-MM-DD found anywhere in the point — last-resort date. */
function pointDate(p: any): string | null {
  const m = JSON.stringify(p).match(/\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : null
}

export async function GET(req: Request) {
  const token = await getAccessToken()
  if (!token) {
    return NextResponse.json(
      { connected: false, hint: 'visit /api/fitbit/login to connect' },
      { status: 401 },
    )
  }
  const url = new URL(req.url)
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 14))
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - (days - 1))
  const startKey = ymd(start)

  const out: Record<string, Entry> = {}
  const set = (date: string | null, k: keyof Entry, v: number | null) => {
    if (!date || date < startKey || v == null) return
    ;(out[date] ||= {})[k] = v
  }

  const results = await Promise.allSettled([
    listDataPoints('sleep', token).then((points) =>
      points.forEach((p: any) => {
        const s = payload(p, 'sleep')
        if (!s) return
        const date = localDate(s.interval?.endTime, s.interval?.endUtcOffset) || pointDate(p)
        const asleep = num(s.summary?.minutesAsleep)
        const inBed = num(s.summary?.minutesInSleepPeriod)
        if (asleep != null) {
          set(date, 'sleepHours', Math.round((asleep / 60) * 10) / 10)
          if (inBed) set(date, 'sleepPerf', Math.round((asleep / inBed) * 100))
        }
      }),
    ),
    listDataPoints('heart-rate-variability', token).then((points) => {
      // possibly several samples per day (nightly readings) — average them
      const byDate: Record<string, number[]> = {}
      points.forEach((p: any) => {
        const h = payload(p, 'heartRateVariability')
        const v = num(h?.rootMeanSquareOfSuccessiveDifferencesMilliseconds)
        const date =
          localDate(h?.sampleTime?.physicalTime, h?.sampleTime?.utcOffset) || pointDate(p)
        if (date && v != null) (byDate[date] ||= []).push(v)
      })
      Object.entries(byDate).forEach(([date, vals]) =>
        set(date, 'hrv', Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10),
      )
    }),
    listDataPoints('daily-resting-heart-rate', token).then((points) =>
      points.forEach((p: any) => {
        const r = payload(p, 'dailyRestingHeartRate')
        if (!r) return
        const date = r.date?.year
          ? `${r.date.year}-${pad(r.date.month)}-${pad(r.date.day)}`
          : typeof r.date === 'string'
            ? r.date.slice(0, 10)
            : pointDate(p)
        set(date, 'rhr', num(r.beatsPerMinute ?? r.value?.beatsPerMinute))
      }),
    ),
  ])
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => String(r.reason).slice(0, 300))

  return NextResponse.json({ connected: true, days: out, errors })
}
