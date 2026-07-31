'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * VoiceBadge — a tap-to-talk mic for the coach.
 *
 * Tap once to start listening, speak your question, tap again to finish: it
 * stops the mic, opens the coach with what you said, and gets the answer. No
 * wake phrase and no guessing when your sentence ended — you bracket it with
 * two taps, which is the only thing that works reliably across browsers (Safari
 * and iOS especially never mark speech "final" dependably in continuous mode).
 *
 * Built on the browser's SpeechRecognition (Web Speech API): audio goes only to
 * the browser's own recognition service, there's no server component, and the
 * mic is live *only* between the two taps — never on page load, never in the
 * background.
 *
 * The `suspended` prop is accepted for compatibility (the coach reads answers
 * aloud); it's a no-op here because the mic is already off by the time an answer
 * plays, so it can never hear itself.
 */

type VState = 'unsupported' | 'off' | 'listening' | 'error'

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

function getCtor(): (new () => SRLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => SRLike; webkitSpeechRecognition?: new () => SRLike }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export default function VoiceBadge({
  onWake,
}: {
  onWake: (query: string) => void
  /** Accepted so the parent can keep passing it; unused (see file header). */
  suspended?: boolean
}) {
  const [state, setState] = useState<VState>('off')
  const [reason, setReason] = useState<string | null>(null)
  const recRef = useRef<SRLike | null>(null)
  const listeningRef = useRef(false) // true between the two taps
  const capturedRef = useRef('') // finalized text, accumulated across restarts
  const interimRef = useRef('') // the current not-yet-final words
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  /** Begin a capture session (from a user tap — required for the mic on iOS). */
  function start() {
    const Ctor = getCtor()
    if (!Ctor) {
      setState('unsupported')
      return
    }
    capturedRef.current = ''
    interimRef.current = ''
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) capturedRef.current += r[0].transcript + ' '
        else interim += r[0].transcript
      }
      interimRef.current = interim
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listeningRef.current = false
        setReason('microphone blocked — allow it in your browser/site settings')
        setState('error')
        return
      }
      // no-speech / aborted / network are transient; onend restarts the session
    }
    rec.onend = () => {
      // Browsers end a session on a pause or a time cap. While the user still
      // has the mic open (hasn't tapped to finish), restart so a multi-sentence
      // question keeps recording. iOS may refuse a non-gesture restart; if so we
      // simply keep whatever was captured and submit it on the finishing tap.
      if (listeningRef.current) {
        try {
          rec.start()
        } catch {
          /* couldn't resume — captured text is preserved for the finishing tap */
        }
      }
    }
    recRef.current = rec
    try {
      rec.start()
      listeningRef.current = true
      setReason(null)
      setState('listening')
    } catch {
      setReason('could not start the microphone — try again')
      setState('error')
    }
  }

  /** Second tap: stop the mic, and send whatever was said to the coach. */
  function finish() {
    listeningRef.current = false
    const rec = recRef.current
    recRef.current = null
    if (rec) {
      rec.onend = null
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
    }
    const full = (capturedRef.current + ' ' + interimRef.current).replace(/\s+/g, ' ').trim()
    capturedRef.current = ''
    interimRef.current = ''
    setState('off')
    if (full) onWakeRef.current(full) // opens the coach, shows the text, answers
  }

  /** Drop the mic without submitting (unmount / teardown). */
  function release() {
    listeningRef.current = false
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
  }

  useEffect(() => {
    if (!getCtor()) setState('unsupported')
    return () => release()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const listening = state === 'listening'
  const label =
    state === 'unsupported'
      ? 'voice unsupported'
      : state === 'error'
        ? 'voice error'
        : listening
          ? 'listening — tap to send'
          : 'Hey Coach'

  const dotColor = listening ? '#6EE7B7' : state === 'error' ? '#f5c451' : 'rgba(255,255,255,.35)'

  return (
    <button
      type="button"
      onClick={() => {
        if (state === 'unsupported') return
        if (listening) finish()
        else start()
      }}
      disabled={state === 'unsupported'}
      title={
        state === 'unsupported'
          ? "This browser doesn't support voice recognition"
          : state === 'error'
            ? (reason ?? 'voice error') + ' — tap to try again'
            : listening
              ? 'Tap when you finish speaking'
              : 'Tap, speak your question, then tap again'
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
        background: listening ? 'rgba(16,32,24,.92)' : 'rgba(10,12,11,.82)',
        backdropFilter: 'blur(14px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(14px) saturate(1.2)',
        border: listening ? '1px solid rgba(110,231,183,.5)' : '1px solid rgba(255,255,255,.09)',
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
          boxShadow: listening ? `0 0 0 4px ${dotColor}22` : 'none',
          animation: listening ? 'voiceBadgePulse 0.9s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }}
      />
      {label}
      <style>{`@keyframes voiceBadgePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </button>
  )
}
