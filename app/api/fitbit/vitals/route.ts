import { NextResponse } from 'next/server'
import { getAccessToken, listDataPoints } from '@/lib/fitbit/server'

/**
 * GET /api/fitbit/vitals?days=14 → { connected, days: { 'YYYY-MM-DD':
 * { hrv, rhr, sleepHours, sleepPerf } }, errors: [] }
 *
 * Data comes from the Google Health API (Fitbit's replacement): the `sleep`,
 * `heart-rate-variability`, and `daily-resting-heart-rate` data types. The
 * shape matches the Vitals tile's store exactly so the dashboard merges it
 * straight in. sleepPerf (the tile's "sleep score") fills from the sleep
 * summary's efficiency when the API provides one — Fitbit's app-only score
 * isn't exposed.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

type Entry = { hrv?: number; rhr?: number; sleepHours?: number; sleepPerf?: number }

/** The data union appears either directly on the point or under .data. */
const payload = (p: any, key: string) => p?.[key] ?? p?.data?.[key]

/** First YYYY-MM-DD found in the point's civil/physical time fields. */
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
  const set = (date: string | null, k: keyof Entry, v: unknown) => {
    if (!date || date < startKey) return
    if (typeof v !== 'number' || !Number.isFinite(v)) return
    ;(out[date] ||= {})[k] = v
  }

  const results = await Promise.allSettled([
    listDataPoints('sleep', `sleep.interval.civil_end_time >= "${startKey}T00:00:00"`, token).then(
      (points) =>
        points.forEach((p: any) => {
          const s = payload(p, 'sleep')
          if (!s) return
          const date = (s.interval?.civilEndTime || s.interval?.endTime || pointDate(p) || '').slice(0, 10) || null
          const mins = s.summary?.minutesAsleep
          if (typeof mins === 'number') set(date, 'sleepHours', Math.round((mins / 60) * 10) / 10)
          const eff = s.summary?.efficiency ?? s.efficiency
          set(date, 'sleepPerf', eff)
        }),
    ),
    listDataPoints(
      'heart-rate-variability',
      `heart_rate_variability.sample_time.civil_time >= "${startKey}T00:00:00"`,
      token,
    ).then((points) => {
      // possibly several samples per day (nightly readings) — average them
      const byDate: Record<string, number[]> = {}
      points.forEach((p: any) => {
        const h = payload(p, 'heartRateVariability')
        const v = h?.rootMeanSquareOfSuccessiveDifferencesMilliseconds
        const date = pointDate(p)
        if (date && typeof v === 'number') (byDate[date] ||= []).push(v)
      })
      Object.entries(byDate).forEach(([date, vals]) =>
        set(date, 'hrv', Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10),
      )
    }),
    listDataPoints(
      'daily-resting-heart-rate',
      `daily_resting_heart_rate.date >= "${startKey}"`,
      token,
    ).then((points) =>
      points.forEach((p: any) => {
        const r = payload(p, 'dailyRestingHeartRate')
        if (!r) return
        const date =
          typeof r.date === 'string'
            ? r.date.slice(0, 10)
            : r.date?.year
              ? `${r.date.year}-${pad(r.date.month)}-${pad(r.date.day)}`
              : pointDate(p)
        set(date, 'rhr', r.beatsPerMinute ?? r.value?.beatsPerMinute)
      }),
    ),
  ])
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => String(r.reason).slice(0, 300))

  return NextResponse.json({ connected: true, days: out, errors })
}
