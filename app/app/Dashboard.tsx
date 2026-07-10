'use client'

import { useEffect, useState } from 'react'
import styles from './dashboard.module.css'
import DashboardHeader from './DashboardHeader'
import WelcomeBackdrop from '@/components/WelcomeBackdrop'
import DashboardHeaderGem from './DashboardHeaderGem'
import DashboardGrid from './DashboardGrid'
import '@/components/veeTiles.css'
import { dashboardChrome, backgroundAccent, DEFAULT_CHROME, type DashboardChrome } from '@/lib/tiles/dashboardChrome'
import { syncWipe } from '@/lib/sync'

interface DashboardProps {
  firstName: string | null
  userId: string
}

/* ── "Start from scratch": a true hard reset (opened by clicking the V) ──
 * Wipes saved data + tiles + customization and turns the board black. The
 * checkbox keeps the ambient background (mountains + particles); off = pure
 * black void. Files built in VS Code stay on disk — that's the way back. */
function ScratchPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [keepBg, setKeepBg] = useState(false)
  const [wiping, setWiping] = useState(false)

  const wipe = async () => {
    setWiping(true)
    try {
      await syncWipe() // clear tiles built by talking to Claude (remote)
    } catch {
      /* ignore */
    }
    try {
      window.localStorage.clear() // data + customization, gone
      // A black void is a persisted background; keeping the ambiance is the default world bg.
      if (!keepBg) dashboardChrome.setBackground(userId, { mode: 'solid', color: '#000' })
      // Mark a deliberate reset so the board shows a CLEAN canvas — just header +
      // background, no middle onboarding text (set after clear so it survives).
      window.localStorage.setItem('vitality:scratched', '1')
    } catch {
      /* ignore */
    }
    window.location.reload()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Start from scratch"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !wiping) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,.62)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: 'min(460px, 100%)',
          background: 'var(--bg-elevated, #121212)',
          border: '1px solid var(--border, #262626)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0,0,0,.6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 18px',
            borderBottom: '1px solid var(--border, #262626)',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--fg, #fff)' }}>Start from scratch?</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={wiping}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted, #8a8f98)',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div style={{ padding: '22px 24px' }}>
          <p style={{ color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
            This turns everything <strong style={{ color: 'var(--fg)' }}>black</strong> and wipes your saved data,
            tiles, and customization — a clean slate. Anything you built in VS&nbsp;Code stays on disk, so that&apos;s
            your way back. This can&apos;t be undone.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 18,
              color: 'var(--fg)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <input type="checkbox" checked={keepBg} onChange={(e) => setKeepBg(e.target.checked)} />
            Keep the background (mountains + particles)
          </label>
          <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={wiping}
              style={{
                flex: 1,
                padding: '0.7rem 1rem',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={wipe}
              disabled={wiping}
              style={{
                flex: 1,
                padding: '0.7rem 1rem',
                borderRadius: 999,
                background: '#ff6b6b',
                color: '#160404',
                border: 'none',
                fontWeight: 600,
                cursor: wiping ? 'not-allowed' : 'pointer',
                opacity: wiping ? 0.6 : 1,
              }}
            >
              {wiping ? 'Wiping…' : 'Start from scratch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The whole base app: one dashboard. The Vitality character lives in the header
 * gem next to the greeting; below sits the animated-orb tile grid. Every tile is
 * an inert "slot" you fill with your own sealed HTML (see public/tiles/README.md).
 *
 * Zero backend: chrome (wallpaper + greeting) is localStorage, tiles are static
 * files under /public/tiles, and there's no auth. `userId` is a constant so the
 * localStorage namespaces (chrome, tile skins, layout) stay stable per browser.
 */
export default function Dashboard({ firstName, userId }: DashboardProps) {
  const avatarInitial = (firstName?.trim()?.[0] || 'V').toUpperCase()
  const [chrome, setChrome] = useState<DashboardChrome | undefined>(undefined)
  const [scratchOpen, setScratchOpen] = useState(false)

  useEffect(() => {
    setChrome(dashboardChrome.get(userId))
  }, [userId])

  const wallAccent = chrome ? backgroundAccent(chrome.background) : '#6EE7B7'
  const showGem = chrome?.gem.show ?? true

  return (
    <main className={`${styles.page} ${styles.oneScreen} grain-overlay`} style={{ ['--wall-accent' as string]: wallAccent }}>
      <WelcomeBackdrop background={chrome?.background} />

      <div className={styles.shell}>
        <div className={styles.headerRow}>
          {showGem && <DashboardHeaderGem className={styles.headerGem} />}
          <DashboardHeader firstName={firstName} greeting={chrome?.greeting} date={chrome?.date} />
          {/* The V (top-right): click to start from scratch (hard reset → black). */}
          <div
            className={styles.profileAvatar}
            onClick={() => setScratchOpen(true)}
            role="button"
            tabIndex={0}
            title="Start from scratch"
            aria-label="Start from scratch"
            style={{ cursor: 'pointer' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setScratchOpen(true)
              }
            }}
          >
            <span>{avatarInitial}</span>
          </div>
        </div>

        <DashboardGrid userId={userId} chrome={chrome ?? DEFAULT_CHROME} />
      </div>

      {scratchOpen && <ScratchPanel userId={userId} onClose={() => setScratchOpen(false)} />}
    </main>
  )
}
