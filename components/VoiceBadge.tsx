'use client'

import { useEffect, useRef, useState } from 'react'
import { parseWake } from '@/lib/tiles/wakePhrase'

/**
 * VoiceBadge — start the coach by voice OR by tap.
 *
 * Two ways in, one capture flow:
 *  - Say "Hey Coach" (hands-free): a background listener scans for the phrase
 *    and then captures whatever you ask. "Hey Coach, how did I sleep" in one
 *    breath works; so does "Hey Coach" then a pause then the question.
 *  - Tap the badge: starts capturing immediately, no phrase needed.
 * Either way it ends the same: a tap, or ~3s of silence, sends what you said —
 * it opens the coach with your words and answers.
 *
 * Built on the browser's SpeechRecognition (Web Speech API): audio goes only to
 * the browser's own recognition service, no server component, nothing stored.
 * The wake word needs the mic listening in the background, which is reliable on
 * desktop Chrome but flaky on iOS Safari (it needs a tap to (re)start the mic
 * and suspends it in the background) — there, tap-to-talk is the dependable
 * path. `suspended` pauses the mic while the coach reads an answer aloud so it
 * never hears itself.
 */

const SILENCE_SEND_MS = 3000 // auto-send this long after the last word heard

type VState = 'unsupported' | 'idle' | 'capturing' | 'error'

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

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

export default function VoiceBadge({
  onWake,
  suspended = false,
}: {
  onWake: (query: string) => void
  suspended?: boolean
}) {
  const [state, setState] = useState<VState>('idle')
  const [reason, setReason] = useState<string | null>(null)
  const recRef = useRef<SRLike | null>(null)
  const runningRef = useRef(false) // we intend the mic to be on
  const modeRef = useRef<'wake' | 'capture'>('wake')
  // captured question = baseRef + (current session transcript after cutRef)
  const baseRef = useRef('') // text carried in (wake remainder / folded restarts)
  const cutRef = useRef(0) // chars of THIS session to drop (the wake phrase)
  const sessionRef = useRef('') // latest full transcript of the current session
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  function clearSilence() {
    if (silenceRef.current) {
      clearTimeout(silenceRef.current)
      silenceRef.current = null
    }
  }
  function armSilence() {
    clearSilence()
    silenceRef.current = setTimeout(() => {
      if (modeRef.current === 'capture') finish()
    }, SILENCE_SEND_MS)
  }

  /** The question so far: carried-in text + this session's words past the wake phrase. */
  function liveCaptured(): string {
    return collapse(baseRef.current + ' ' + sessionRef.current.slice(cutRef.current))
  }

  function buildRec(): SRLike | null {
    const Ctor = getCtor()
    if (!Ctor) return null
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      let full = ''
      for (let i = 0; i < e.results.length; i++) full += e.results[i][0].transcript
      sessionRef.current = full
      if (modeRef.current === 'capture') {
        if (liveCaptured()) armSilence() // every word resets the 3s auto-send
        return
      }
      // wake mode: watch for "hey coach", then capture what follows
      const hit = parseWake(full)
      if (hit) {
        modeRef.current = 'capture'
        baseRef.current = hit.rest || '' // words said after "hey coach" this breath
        cutRef.current = full.length // continuation in this same session is captured
        setState('capturing')
        if (baseRef.current.trim()) armSilence()
      }
    }
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        runningRef.current = false
        // In capture mode the user just tapped — a block here is a real, worth-
        // surfacing error. In wake mode this is the browser refusing to start the
        // background mic without a user gesture (iOS Safari always does this on
        // load) — NOT a real failure, so sit idle as "Hey Jarvis" and let a tap
        // start it with the gesture iOS wants, instead of showing "voice error".
        if (modeRef.current === 'capture') {
          setReason('microphone blocked — allow it in your browser/site settings')
          setState('error')
        } else {
          setState('idle')
        }
        return
      }
      // no-speech / aborted / network are transient — onend restarts the session
    }
    rec.onend = () => {
      if (!runningRef.current || suspendedRef.current) return
      // fold any in-progress capture across the restart so nothing is lost
      if (modeRef.current === 'capture') {
        baseRef.current = collapse(baseRef.current + ' ' + sessionRef.current.slice(cutRef.current))
        cutRef.current = 0
      }
      sessionRef.current = ''
      try {
        rec.start()
      } catch {
        /* iOS may refuse a non-gesture restart — a tap will resume it */
      }
    }
    return rec
  }

  /** (Re)start the mic in a given mode with a clean session. */
  function startRec(mode: 'wake' | 'capture'): boolean {
    stopRec()
    const rec = buildRec()
    if (!rec) {
      setState('unsupported')
      return false
    }
    modeRef.current = mode
    sessionRef.current = ''
    recRef.current = rec
    runningRef.current = true
    try {
      rec.start()
      setReason(null)
      return true
    } catch {
      runningRef.current = false
      return false
    }
  }

  function stopRec() {
    const rec = recRef.current
    recRef.current = null
    runningRef.current = false
    if (rec) {
      rec.onend = null
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
    }
  }

  /** Tap when idle: start capturing immediately (no wake phrase). */
  function beginCaptureFresh() {
    clearSilence()
    baseRef.current = ''
    cutRef.current = 0
    if (startRec('capture')) setState('capturing')
    else {
      setReason('could not start the microphone — try again')
      setState('error')
    }
  }

  /** Tap while capturing, or 3s of silence: send what was said, resume wake-listening. */
  function finish() {
    clearSilence()
    const q = liveCaptured()
    baseRef.current = ''
    cutRef.current = 0
    startRec('wake') // back to passively listening for "Hey Coach"
    setState('idle')
    if (q) onWakeRef.current(q) // opens the coach, shows the text, answers
  }

  // start passively listening for the wake word on mount (desktop). iOS may
  // refuse until the first tap; after that it resumes between captures.
  useEffect(() => {
    if (!getCtor()) {
      setState('unsupported')
      return
    }
    startRec('wake')
    return () => {
      clearSilence()
      stopRec()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // pause the mic while the coach speaks its answer, so it can't hear itself
  useEffect(() => {
    if (suspended) {
      clearSilence()
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
    } else if (state !== 'capturing' && state !== 'unsupported' && state !== 'error') {
      // resume wake-listening once the answer finishes
      if (recRef.current) {
        try {
          recRef.current.start()
        } catch {
          startRec('wake')
        }
      } else {
        startRec('wake')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended])

  // Nothing to offer if the browser has no speech recognition (e.g. an iOS
  // web-view, where the NATIVE app handles the wake word instead) — hide the
  // badge rather than show a dead "voice unsupported" pill.
  if (state === 'unsupported') return null

  const capturing = state === 'capturing'
  const label =
    state === 'error'
      ? 'voice error'
      : capturing
        ? 'listening — tap to send'
        : 'Hey Jarvis'

  const dotColor = capturing ? '#6EE7B7' : state === 'error' ? '#f5c451' : state === 'idle' ? 'rgba(110,231,183,.45)' : 'rgba(255,255,255,.35)'

  return (
    <button
      type="button"
      onClick={() => {
        if (capturing) finish()
        else beginCaptureFresh() // idle or error → start capturing now
      }}
      title={
        state === 'error'
          ? (reason ?? 'voice error') + ' — tap to try again'
          : capturing
            ? 'Tap when you finish speaking (or just pause)'
            : 'Say "Hey Jarvis", or tap and speak'
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
        background: capturing ? 'rgba(16,32,24,.92)' : 'rgba(10,12,11,.82)',
        backdropFilter: 'blur(14px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(14px) saturate(1.2)',
        border: capturing ? '1px solid rgba(110,231,183,.5)' : '1px solid rgba(255,255,255,.09)',
        borderRadius: 999,
        padding: '7px 14px 7px 11px',
        color: 'rgba(255,255,255,.75)',
        fontSize: 12,
        fontFamily: 'ui-monospace, Menlo, monospace',
        letterSpacing: '.03em',
        cursor: 'pointer',
        boxShadow: '0 8px 24px rgba(0,0,0,.4)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: capturing ? `0 0 0 4px ${dotColor}22` : 'none',
          animation: capturing ? 'voiceBadgePulse 0.9s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }}
      />
      {label}
      <style>{`@keyframes voiceBadgePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </button>
  )
}
