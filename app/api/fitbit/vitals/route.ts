import { NextResponse } from 'next/server'
import { getAccessToken, fitbitGet } from '@/lib/fitbit/server'

/**
 * GET /api/fitbit/vitals?days=14 → { connected, days: { 'YYYY-MM-DD':
 * { hrv, rhr, sleepHours, sleepPerf } }, errors: [] }
 *
 * The shape matches the Vitals tile's store exactly, so the dashboard can
 * merge it straight in. sleepPerf carries Fitbit's sleep *efficiency* — the
 * app's proprietary sleep score isn't in the public API, and efficiency is
 * the closest per-night percentage it exposes.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

type Entry = { hrv?: number; rhr?: number; sleepHours?: number; sleepPerf?: number }

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
  const [s, e] = [ymd(start), ymd(end)]

  const out: Record<string, Entry> = {}
  const set = (date: string, k: keyof Entry, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return
    ;(out[date] ||= {})[k] = v
  }

  const results = await Promise.allSettled([
    fitbitGet(`/1/user/-/hrv/date/${s}/${e}.json`, token).then((j) =>
      (j.hrv || []).forEach((r: any) => set(r.dateTime, 'hrv', r.value?.dailyRmssd)),
    ),
    fitbitGet(`/1/user/-/activities/heart/date/${s}/${e}.json`, token).then((j) =>
      (j['activities-heart'] || []).forEach((r: any) =>
        set(r.dateTime, 'rhr', r.value?.restingHeartRate),
      ),
    ),
    fitbitGet(`/1.2/user/-/sleep/date/${s}/${e}.json`, token).then((j) =>
      (j.sleep || [])
        .filter((r: any) => r.isMainSleep !== false)
        .forEach((r: any) => {
          if (typeof r.minutesAsleep === 'number')
            set(r.dateOfSleep, 'sleepHours', Math.round((r.minutesAsleep / 60) * 10) / 10)
          set(r.dateOfSleep, 'sleepPerf', r.efficiency)
        }),
    ),
  ])
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => String(r.reason).slice(0, 200))

  return NextResponse.json({ connected: true, days: out, errors })
}
