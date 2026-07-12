'use client'

import { useEffect } from 'react'
import { tileStore } from '@/lib/tiles/tileStore'

/**
 * Pulls the last two weeks of Fitbit vitals on dashboard load and merges them
 * into the Vitals tile's store (same shape: date -> {hrv, rhr, sleepHours,
 * sleepPerf}). The tile itself stays sealed — it just finds the numbers
 * already there next time it opens.
 *
 * Manual entries win: Fitbit only fills fields you haven't typed for a date.
 * Not connected yet (401) or server down → silent no-op; manual entry keeps
 * working exactly as before.
 */
export default function FitbitSync({ userId }: { userId: string }) {
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/fitbit/vitals?days=14')
        if (!res.ok) {
          console.info('[fitbit] vitals sync skipped — API said', res.status)
          return
        }
        const { days } = await res.json()
        if (cancelled || !days || typeof days !== 'object') return

        const cur = await tileStore.loadData(userId, 'vitals')
        const store: Record<string, Record<string, number>> =
          cur && typeof cur === 'object' && !Array.isArray(cur)
            ? { ...(cur as Record<string, Record<string, number>>) }
            : {}
        let changed = false
        for (const [date, vals] of Object.entries(days as Record<string, Record<string, number>>)) {
          const entry = { ...(store[date] || {}) }
          for (const [k, v] of Object.entries(vals)) {
            if (entry[k] == null) {
              entry[k] = v
              changed = true
            }
          }
          store[date] = entry
        }
        if (changed) await tileStore.saveData(userId, 'vitals', store)

        /* Hand today's readiness to the Train tile so it can adapt the day
           (banner + one-tap deload). Same recovery formula as the Vitals
           tile; hrvBase is the trailing 7-day average for a delta callout. */
        const pad = (n: number) => String(n).padStart(2, '0')
        const now = new Date()
        const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        const h = store[todayKey]
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
        const recovery = (() => {
          if (!h) return null
          const parts: number[] = []
          const w: number[] = []
          if (typeof h.hrv === 'number') { parts.push(clamp01((h.hrv - 20) / 70) * 100); w.push(0.5) }
          if (typeof h.rhr === 'number') { parts.push(clamp01((80 - h.rhr) / 38) * 100); w.push(0.25) }
          // the Vitals tile's "how do you feel" tap nudges sleep and joins the
          // blend, mirroring its estRecovery so both tiles agree on the number
          const feelAdj = typeof h.feel === 'number' ? ({ 1: -10, 2: 0, 3: 4, 4: 8 }[h.feel] ?? 0) : 0
          if (typeof h.sleepPerf === 'number') { parts.push(Math.max(1, Math.min(100, h.sleepPerf + feelAdj))); w.push(0.25) }
          else if (typeof h.sleepHours === 'number') { parts.push(clamp01(h.sleepHours / 8) * 100); w.push(0.25) }
          if (typeof h.feel === 'number') { parts.push({ 1: 20, 2: 50, 3: 75, 4: 95 }[h.feel] ?? 50); w.push(0.3) }
          if (!parts.length) return null
          const sw = w.reduce((a, b) => a + b, 0)
          return Math.max(1, Math.min(99, Math.round(parts.reduce((s, p, i) => s + p * w[i], 0) / sw)))
        })()
        if (recovery != null) {
          const hrvs = Object.keys(store)
            .filter((k) => k < todayKey)
            .sort()
            .slice(-7)
            .map((k) => store[k]?.hrv)
            .filter((v): v is number => typeof v === 'number')
          const hrvBase = hrvs.length >= 3 ? Math.round((hrvs.reduce((a, b) => a + b, 0) / hrvs.length) * 10) / 10 : null
          const readiness = {
            date: todayKey, recovery,
            hrv: h.hrv ?? null, rhr: h.rhr ?? null, sleepHours: h.sleepHours ?? null, hrvBase,
          }
          const train = await tileStore.loadData(userId, 'train')
          if (train && typeof train === 'object' && !Array.isArray(train)) {
            // existing state (any version — the tile's boot migrates): ride along
            ;(train as any).readiness = readiness
            await tileStore.saveData(userId, 'train', train)
          } else {
            // tile never opened in this browser: seed a bare object; the tile
            // adopts .readiness off the raw load even when it rebuilds state
            await tileStore.saveData(userId, 'train', { readiness })
          }
          console.info('[fitbit] readiness synced for', readiness.date, '— recovery', readiness.recovery + '%')
        }
      } catch {
        /* offline or dev server hiccup — the tile still works manually */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])
  return null
}
