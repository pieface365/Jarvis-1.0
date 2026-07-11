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
        if (!res.ok) return
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
