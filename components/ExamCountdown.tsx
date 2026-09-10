'use client'

import { useEffect, useState } from 'react'
import { tileStore } from '@/lib/tiles/tileStore'
import { syncEnabled, syncLoad } from '@/lib/sync'

/* Read the School tile the way the host does: local first, but the cloud row
   wins when sync is on — otherwise a phone that synced an exam wouldn't show
   it here. Same rule as FitbitSync. */
async function loadTileData(userId: string, id: string): Promise<unknown> {
  let data: unknown = await tileStore.loadData(userId, id)
  if (syncEnabled()) {
    const remote = await syncLoad(id)
    if (remote != null) data = remote
  }
  return data
}

const pad = (n: number) => String(n).padStart(2, '0')
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Whole days from today to a YYYY-MM-DD, counted on calendar dates so a late
 *  evening never reads as one day fewer than the calendar says. */
function daysUntil(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const then = new Date(+m[1], +m[2] - 1, +m[3])
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  then.setHours(0, 0, 0, 0)
  return Math.round((then.getTime() - now.getTime()) / 86400000)
}

type Exam = { title: string; subject: string; due: string; days: number }

/** Soonest exam still ahead of us, from the School tile's task list. */
function nextExam(store: unknown): Exam | null {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return null
  const items = (store as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const today = todayKey()
  const upcoming: Exam[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    if (String(it.type ?? '').toLowerCase() !== 'exam') continue
    if (it.done) continue
    const due = typeof it.due === 'string' ? it.due : ''
    if (!due || due < today) continue
    const days = daysUntil(due)
    if (days == null) continue
    upcoming.push({
      title: String(it.title ?? 'Exam'),
      subject: String(it.subject ?? ''),
      due,
      days,
    })
  }
  upcoming.sort((a, b) => a.due.localeCompare(b.due))
  return upcoming[0] ?? null
}

function phrase(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

/**
 * A quiet line under the greeting counting down to the next exam. Renders
 * nothing at all when none is scheduled, so the dashboard never carries an
 * empty placeholder.
 */
export default function ExamCountdown({ userId }: { userId: string }) {
  const [exam, setExam] = useState<Exam | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const store = await loadTileData(userId, 'school')
        if (!cancelled) setExam(nextExam(store))
      } catch {
        /* tile never opened, or offline — just show nothing */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  if (!exam) return null

  const urgent = exam.days <= 3
  const dateLabel = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exam.due)
    if (!m) return ''
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  })()

  return (
    <p
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap',
        margin: '6px 0 0',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: urgent ? 'var(--wall-accent, var(--mint))' : 'var(--muted)',
      }}
    >
      <span style={{ fontWeight: 700 }}>{exam.title}</span>
      <span style={{ opacity: 0.75 }}>
        {exam.subject ? `${exam.subject} · ` : ''}
        {dateLabel}
      </span>
      <span style={{ fontWeight: 700 }}>{phrase(exam.days)}</span>
    </p>
  )
}
