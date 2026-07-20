'use client'

import { useEffect, useRef, useState } from 'react'
import { parseWake } from '@/lib/tiles/wakePhrase'

/**
 * VoiceBadge — the always-mounted "Hey Coach" wake-word listener + its toggle.
 *
 * Lives at the DashboardGrid level (not inside CoachPanel) so the wake phrase
 * keeps working no matter what's open — another tile, the coach panel, or the
 * home grid. Built on the browser's SpeechRecognition (Web Speech API): audio
 * never leaves the device except to the browser's own recognition service,
 * there's no server component, and nothing is recorded or stored.
 *
 * "Hey Coach, <question>" in one breath fires immediately; "Hey Coach" alone
 * opens an 8s window for the follow-up sentence. Best-effort by nature: the
 * browser ends a recognition session on silence or a time cap, so this
 * restarts itself whenever that happens while still armed — but iOS Safari in
 * particular suspends background mic access aggressively, so voice may need
 * re-arming there after switching apps or locking the screen.
 *
 * `suspended` mutes listening while the coach's own TTS answer is playing, so
 * it can never hear (and react to) itself.
 */

type VState = 'unsupported' | 'off' | 'listening' | 'awaiting' | 'error'

interface SRResult {
  isFinal: boolean
  0: { transcript: string }
}
interface SREvent {
  resultIndex: number
  results: { length: number; [i: number]: SRResult }
}
interface SRLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SREvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

const STORE_KEY = 'vitality:coach:voice'
const AWAIT_MS = 8000

function getCtor(): (new () => SRLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => SRLike; webkitSpeechRecognition?: new () => SRLike }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export default function VoiceBadge({
  onWake,
  suspended = false,
}: {
  onWake: (query: string) => void
  suspended?: boolean
}) {
  const [state, setState] = useState<VState>('off')
  const [reason, setReason] = useState<string | null>(null)
  const recRef = useRef<SRLike | null>(null)
  const enabledRef = useRef(false)
  const awaitingRef = useRef(false)
  const awaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  function clearAwait() {
    awaitingRef.current = false
    if (awaitTimerRef.current) {
      clearTimeout(awaitTimerRef.current)
      awaitTimerRef.current = null
    }
  }

  function handleFinal(text: string) {
    if (awaitingRef.current) {
      clearAwait()
      const q = text.trim()
      if (q) onWakeRef.current(q)
      setState('listening')
      return
    }
    const hit = parseWake(text)
    if (!hit) return
    if (hit.rest) {
      onWakeRef.current(hit.rest)
      setState('listening')
    } else {
      awaitingRef.current = true
      setState('awaiting')
      awaitTimerRef.current = setTimeout(() => {
        clearAwait()
        setState('listening')
      }, AWAIT_MS)
    }
  }

  function start() {
    const Ctor = getCtor()
    if (!Ctor) {
      setState('unsupported')
      return
    }
    enabledRef.current = true
    try {
      window.localStorage.setItem(STORE_KEY, '1')
    } catch {
      /* ignore */
    }
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) handleFinal(r[0].transcript)
      }
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        // permission denied — retrying would just re-prompt forever, so disarm
        enabledRef.current = false
        try {
          window.localStorage.setItem(STORE_KEY, '0')
        } catch {
          /* ignore */
        }
        setReason('microphone blocked — check your browser/site permissions')
        setState('error')
        return
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setReason(e.error)
        setState('error')
      }
    }
    rec.onend = () => {
      // browsers end the session on silence / a time cap — restart while armed
      // and not deliberately paused for TTS, so "always listening" actually holds
      if (enabledRef.current && !suspendedRef.current) {
        try {
          rec.start()
        } catch {
          setTimeout(() => {
            if (enabledRef.current && !suspendedRef.current) {
              try {
                rec.start()
              } catch {
                /* give up quietly; the badge stays on 'listening' until the user notices and retoggles */
              }
            }
          }, 300)
        }
      }
    }
    recRef.current = rec
    try {
      rec.start()
      setReason(null)
      setState('listening')
    } catch {
      setState('error')
    }
  }

  function stop() {
    enabledRef.current = false
    clearAwait()
    try {
      window.localStorage.setItem(STORE_KEY, '0')
    } catch {
      /* ignore */
    }
    const rec = recRef.current
    recRef.current = null
    if (rec) {
      rec.onend = null
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
    }
    setState((s) => (s === 'unsupported' ? s : 'off'))
  }

  // mirrors `suspended` in a ref so the onend closure (bound at start()) reads
  // the live value instead of the value from whenever the listener was created
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended

  // pause/resume around the coach speaking its own answer aloud, so the mic
  // can never hear — and react to — Coach's own voice
  useEffect(() => {
    if (!enabledRef.current) return
    const rec = recRef.current
    if (!rec) return
    if (suspended) {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    } else if (state !== 'awaiting') {
      try {
        rec.start()
      } catch {
        /* already running */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended])

  useEffect(() => {
    if (!getCtor()) {
      setState('unsupported')
      return
    }
    let wasOn = false
    try {
      wasOn = window.localStorage.getItem(STORE_KEY) === '1'
    } catch {
      /* ignore */
    }
    if (wasOn) start()
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label =
    state === 'unsupported'
      ? 'voice unsupported'
      : state === 'off'
        ? 'Hey Coach'
        : state === 'awaiting'
          ? 'ask now…'
          : state === 'error'
            ? 'voice error'
            : 'listening'

  const dotColor =
    state === 'awaiting' ? '#6EE7B7' : state === 'listening' ? 'rgba(110,231,183,.7)' : state === 'error' ? '#f5c451' : 'rgba(255,255,255,.35)'

  return (
    <button
      type="button"
      onClick={() => {
        if (state === 'unsupported') return
        if (state === 'off' || state === 'error') start()
        else stop()
      }}
      disabled={state === 'unsupported'}
      title={
        state === 'unsupported'
          ? "This browser doesn't support voice recognition"
          : state === 'error'
            ? (reason ?? 'voice error') + ' — tap to retry'
            : state === 'off'
              ? 'Tap to arm the "Hey Coach" wake phrase'
              : 'Tap to turn voice off'
      }
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(max(10px, env(safe-area-inset-bottom)) + 84px)',
        zIndex: 84,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: 'rgba(10,12,11,.82)',
        backdropFilter: 'blur(14px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(14px) saturate(1.2)',
        border: '1px solid rgba(255,255,255,.09)',
        borderRadius: 999,
        padding: '7px 14px 7px 11px',
        color: state === 'unsupported' ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.75)',
        fontSize: 12,
        fontFamily: 'ui-monospace, Menlo, monospace',
        letterSpacing: '.03em',
        cursor: state === 'unsupported' ? 'default' : 'pointer',
        boxShadow: '0 8px 24px rgba(0,0,0,.4)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: state === 'listening' || state === 'awaiting' ? `0 0 0 4px ${dotColor}22` : 'none',
          animation: state === 'awaiting' ? 'voiceBadgePulse 0.9s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }}
      />
      {label}
      <style>{`@keyframes voiceBadgePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </button>
  )
}
