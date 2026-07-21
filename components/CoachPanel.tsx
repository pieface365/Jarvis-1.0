'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * CoachPanel — the dashboard's AI coach chat, opened from the dock, the grid
 * tile, or by saying "Hey Coach" (VoiceBadge, mounted in DashboardGrid).
 *
 * Lives at host level (not a sealed tile) because the coach spans every tile's
 * data: the host page is same-origin, so the gate cookie rides along to
 * /api/coach and the server reads the tile data itself. The transcript
 * persists in localStorage so a conversation survives reloads.
 *
 * Also speaks its answers aloud (browser text-to-speech) when the speaker
 * toggle is on, so the coach is usable fully hands-free with VoiceBadge.
 */

type Source = { url: string; title: string | null }
type Msg = { role: 'user' | 'assistant'; text: string; sources?: Source[]; error?: boolean }

const STORE_KEY = 'vitality:coach:chat'
const SPEAK_KEY = 'vitality:coach:speak'
const MAX_KEPT = 60 // transcript cap in storage
const SENT_WINDOW = 20 // how much history each question carries to the server

const ERROR_TEXT: Record<string, string> = {
  no_key:
    'The coach needs an Anthropic API key. Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables (and .env.local for local dev), then redeploy.',
  rate_limited: 'The AI service is rate-limiting right now — give it a minute and ask again.',
  api_error: 'The AI service returned an error. Try again in a moment.',
  locked: 'The dashboard is locked — reload the page and enter the password.',
  network: 'Could not reach the coach — check your connection and try again.',
}

function loadChat(): Msg[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function saveChat(list: Msg[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-MAX_KEPT)))
  } catch {
    /* quota — the conversation just won't survive a reload */
  }
}

/* ── markdown-lite: **bold**, `code`, [text](url), "- " bullets ─────────── */

function inline(s: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // one pass over bold / code / links, left to right
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    if (m[2] != null) out.push(<strong key={`${keyBase}-${i++}`} style={{ color: 'var(--fg, #ededf0)' }}>{m[2]}</strong>)
    else if (m[4] != null)
      out.push(
        <code key={`${keyBase}-${i++}`} style={{ background: 'rgba(255,255,255,.07)', borderRadius: 4, padding: '1px 5px', fontSize: '.92em' }}>
          {m[4]}
        </code>,
      )
    else if (m[6] != null)
      out.push(
        <a key={`${keyBase}-${i++}`} href={m[7]} target="_blank" rel="noreferrer" style={{ color: 'var(--mint, #6EE7B7)' }}>
          {m[6]}
        </a>,
      )
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function MdText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let key = 0
  const flush = () => {
    if (!bullets.length) return
    blocks.push(
      <ul key={`ul${key++}`} style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ margin: '3px 0' }}>{inline(b, `b${key}-${i}`)}</li>
        ))}
      </ul>,
    )
    bullets = []
  }
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (bullet) {
      bullets.push(bullet[1])
      continue
    }
    flush()
    if (line.trim() === '') continue
    blocks.push(
      <p key={`p${key++}`} style={{ margin: '0 0 10px' }}>
        {inline(line, `l${key}`)}
      </p>,
    )
  }
  flush()
  return <>{blocks}</>
}

/** Plain-text version of an answer for text-to-speech: drop markdown syntax
 *  rather than reading asterisks and brackets aloud. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
}

/* ── the panel ──────────────────────────────────────────────────────────── */

export default function CoachPanel({
  onClose,
  voiceQuery,
  onSpeakingChange,
}: {
  onClose: () => void
  /** A question captured by the "Hey Coach" wake phrase — auto-asked on arrival. */
  voiceQuery?: { text: string; nonce: number } | null
  /** Reported true while an answer is being read aloud, so the wake-word
   *  listener can mute itself and never hear (and react to) the coach's own voice. */
  onSpeakingChange?: (speaking: boolean) => void
}) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [speakSupported] = useState(() => typeof window !== 'undefined' && 'speechSynthesis' in window)
  const [speak, setSpeak] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastVoiceNonce = useRef<number | null>(null)
  const onSpeakingChangeRef = useRef(onSpeakingChange)
  onSpeakingChangeRef.current = onSpeakingChange
  const speakRef = useRef(speak)
  speakRef.current = speak
  // A wake phrase spoken while Coach is still answering: held here rather than
  // dropped, and asked as soon as the current answer lands.
  const pendingVoiceRef = useRef<string | null>(null)
  // Guards state updates from a send() that outlives the component, WITHOUT
  // network-aborting it on unmount: React 18 Strict Mode's dev-only mount →
  // cleanup → mount cycle runs on this SAME instance (refs persist across it),
  // so aborting the in-flight fetch in that cleanup would kill the very first
  // request a voice-triggered auto-ask makes, with nothing left to retry it.
  // Flipping this back to true on the (possible) second mount instead means a
  // dev-only remount is harmless, while a REAL close still stops touching state.
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    // Functional form so this initial load can never clobber a message that
    // send() already queued (e.g. a voice-triggered auto-ask fired from this
    // very mount) — it only adopts the saved transcript while state is still
    // the untouched initial []; on a real mount that's always true anyway.
    setMessages((cur) => (cur.length ? cur : loadChat()))
    try {
      const saved = window.localStorage.getItem(SPEAK_KEY)
      if (saved != null) setSpeak(saved === '1')
    } catch {
      /* default stays on */
    }
    return () => {
      aliveRef.current = false
      if (speakSupported) window.speechSynthesis.cancel()
      onSpeakingChangeRef.current?.(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Read an answer aloud, plain-text, reporting start/end so the wake-word
   *  listener can mute itself for the duration. */
  const speakText = (text: string) => {
    // speakRef, not `speak`: an answer is spoken once streaming finishes, so a
    // mute pressed WHILE it was generating must still win — the render closure
    // captured at send() time would happily read the stale pre-mute value.
    if (!speakSupported || !speakRef.current) return
    const plain = stripMd(text).trim()
    if (!plain) return
    try {
      window.speechSynthesis.cancel() // never overlap a previous answer
      const u = new SpeechSynthesisUtterance(plain)
      u.onstart = () => onSpeakingChangeRef.current?.(true)
      u.onend = () => onSpeakingChangeRef.current?.(false)
      u.onerror = () => onSpeakingChangeRef.current?.(false)
      window.speechSynthesis.speak(u)
    } catch {
      /* no voices installed or similar — fail quiet, the text answer still shows */
    }
  }

  const toggleSpeak = () => {
    setSpeak((cur) => {
      const next = !cur
      try {
        window.localStorage.setItem(SPEAK_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      if (!next && speakSupported) {
        window.speechSynthesis.cancel()
        onSpeakingChangeRef.current?.(false)
      }
      return next
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Freeze the dashboard underneath while the sheet is open. On a phone the
  // grid behind is taller than the screen, and a touch-drag that starts on the
  // panel can still end up scrolling that page instead of the transcript.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Follow the newest message as it streams — but only while the user is
  // parked at the bottom. Without this guard, every streamed chunk yanked them
  // back down, so you couldn't scroll up to re-read an earlier answer while a
  // new one was still generating. onScroll below keeps stickRef in sync; send()
  // re-pins it (you always want to see your own brand-new question).
  const stickRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, status])

  /** Mutate the trailing assistant message (the one being streamed). No-ops
   *  once the component has genuinely unmounted (aliveRef), so a response that
   *  finishes after a real close doesn't touch a gone instance's state. */
  const patchLast = (fn: (m: Msg) => Msg) => {
    if (!aliveRef.current) return
    setMessages((cur) => {
      const next = [...cur]
      next[next.length - 1] = fn(next[next.length - 1])
      saveChat(next)
      return next
    })
  }

  const send = async (override?: string) => {
    const q = (override ?? input).trim()
    if (!q || busy) return
    if (override == null) setInput('')
    stickRef.current = true // a brand-new question always scrolls into view
    setBusy(true)
    setStatus('thinking…')
    const history = [...messages, { role: 'user' as const, text: q }]
    setMessages([...history, { role: 'assistant', text: '' }])
    saveChat(history)

    // kept for a future "stop generating" control; nothing aborts it today —
    // see aliveRef above for why unmount must not auto-abort this fetch
    const ac = new AbortController()
    abortRef.current = ac
    let failed: string | null = null
    let full = '' // accumulated for text-to-speech once streaming finishes
    let fullSources: Source[] | null = null
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          messages: history.slice(-SENT_WINDOW).map((m) => ({ role: m.role, text: m.text })),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null
        failed = err?.error ?? (res.status === 401 ? 'locked' : 'api_error')
      } else {
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            let ev: { t: string; v?: unknown }
            try {
              ev = JSON.parse(line)
            } catch {
              continue
            }
            if (ev.t === 'text' && typeof ev.v === 'string') {
              setStatus(null)
              const chunk = ev.v
              full += chunk
              patchLast((m) => ({ ...m, text: m.text + chunk }))
            } else if (ev.t === 'status') {
              setStatus('searching the web…')
            } else if (ev.t === 'sources' && Array.isArray(ev.v)) {
              const srcs = ev.v as Source[]
              fullSources = srcs
              patchLast((m) => ({ ...m, sources: srcs }))
            } else if (ev.t === 'error') {
              failed = typeof ev.v === 'string' ? ev.v : 'api_error'
            }
          }
        }
      }
    } catch {
      if (!ac.signal.aborted) failed = 'network'
    }
    if (failed) {
      const msg = ERROR_TEXT[failed] ?? ERROR_TEXT.api_error
      full = full || msg
      patchLast((m) => (m.text ? m : { ...m, text: msg, error: true }))
    }
    if (aliveRef.current) {
      setStatus(null)
      setBusy(false)
    } else if (full) {
      // Closed mid-answer: patchLast no-oped, so the reply never reached the
      // saved transcript — leaving a dangling user turn that made the NEXT
      // question send two consecutive user messages. Append it to storage
      // directly so the conversation stays well-formed and the answer the user
      // waited for is still there when they reopen.
      try {
        const saved = loadChat()
        if (saved.length && saved[saved.length - 1].role === 'user') {
          const reply: Msg = { role: 'assistant', text: full }
          if (fullSources) reply.sources = fullSources
          if (failed) reply.error = true
          saveChat([...saved, reply])
        }
      } catch {
        /* storage unavailable — nothing more we can do */
      }
    }
    if (full) speakText(full) // speaks even just after a real close, so a hands-free answer is never silently dropped
  }

  // "Hey Coach, <question>" landed via VoiceBadge — ask it, once per capture.
  // Mid-answer captures are held (send() would early-return on `busy`, and the
  // nonce is already consumed, so the question would vanish with no feedback —
  // invisible in a hands-free flow where the user can't see the panel).
  useEffect(() => {
    if (!voiceQuery || voiceQuery.nonce === lastVoiceNonce.current) return
    lastVoiceNonce.current = voiceQuery.nonce
    if (busy) pendingVoiceRef.current = voiceQuery.text
    else void send(voiceQuery.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceQuery])

  // …and asked the moment the current answer finishes
  useEffect(() => {
    if (busy || !pendingVoiceRef.current) return
    const q = pendingVoiceRef.current
    pendingVoiceRef.current = null
    void send(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  const clear = () => {
    setMessages([])
    try {
      window.localStorage.removeItem(STORE_KEY)
    } catch {
      /* ignore */
    }
  }

  /* Portalled to <body>. DashboardGrid renders inside .shell, which sets
     z-index:5 — that's a stacking context, so the panel's z-index:120 only ever
     competed with .shell's own children. Page chrome mounted at the root above
     z 5 (the ✎ Customize pill, fixed at bottom-left, z 50) painted straight
     over the transcript and swallowed touches there: on a phone that's a
     114×38 dead zone in the middle of the message list, so a drag that started
     on it scrolled nothing. Escaping to the root puts 120 back in charge. */
  const sheet = (
    <>
      {/* backdrop: click anywhere off the panel to close */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 118, background: 'rgba(0,0,0,.45)' }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Coach"
        style={{
          /* 100dvh, not top:0/bottom:0. iOS anchors fixed elements to the LARGE
             viewport, so a top/bottom-pinned panel runs underneath Safari's
             address bar and bottom toolbar — the composer and the last inch of
             the transcript end up in a strip you can't touch. dvh tracks the
             viewport that's actually on screen. */
          position: 'fixed', top: 0, right: 0, zIndex: 120, height: '100dvh',
          width: 'min(480px, 100vw)', display: 'flex', flexDirection: 'column',
          background: 'var(--bg, #0a0b0a)', borderLeft: '1px solid var(--border, #1d1d22)',
          boxShadow: '-18px 0 60px rgba(0,0,0,.55)',
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            // viewportFit:'cover' paints under the notch, so pad the header down
            // past the status bar / dynamic island or the title + close hide there
            padding: 'calc(14px + env(safe-area-inset-top)) 16px 14px',
            borderBottom: '1px solid var(--border, #1d1d22)',
          }}
        >
          <span style={{ fontFamily: 'var(--serif, Georgia)', fontStyle: 'italic', fontSize: 20, color: 'var(--fg, #ededf0)' }}>
            Coach
          </span>
          <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted, #84848c)' }}>
            knows your dashboard
          </span>
          <span style={{ flex: 1 }} />
          {speakSupported && (
            <button
              type="button"
              onClick={toggleSpeak}
              aria-label={speak ? 'Mute spoken answers' : 'Read answers aloud'}
              title={speak ? 'Answers are read aloud — tap to mute' : 'Tap to have answers read aloud'}
              style={{
                background: 'transparent', border: '1px solid var(--border, #2a2a31)',
                color: speak ? 'var(--mint, #6EE7B7)' : 'var(--muted, #84848c)',
                borderRadius: 999, width: 28, height: 28, display: 'grid', placeItems: 'center',
                fontSize: 14, cursor: 'pointer', flexShrink: 0,
              }}
            >
              {speak ? '🔊' : '🔇'}
            </button>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              style={{
                background: 'transparent', border: '1px solid var(--border, #2a2a31)', color: 'var(--muted, #84848c)',
                borderRadius: 999, padding: '5px 12px', fontSize: 12, cursor: busy ? 'default' : 'pointer',
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close coach"
            style={{
              background: 'transparent', border: 'none', color: 'var(--muted, #84848c)',
              fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: '2px 6px',
            }}
          >
            ×
          </button>
        </header>

        <div
          ref={scrollRef}
          onScroll={(e) => {
            // re-pin only when the user returns to the bottom; scrolling up
            // unpins so streamed chunks stop yanking them back down
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          style={{
            flex: 1,
            // a flex child defaults to min-height:auto, i.e. "never shrink below
            // my content" — without this the list grows instead of scrolling
            minHeight: 0,
            overflowY: 'auto',
            // keep a drag inside the panel: without it, hitting either end hands
            // the gesture to the dashboard behind, which reads as "stuck"
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch',
            padding: '18px 16px 8px',
          }}
        >
          {messages.length === 0 && (
            <div style={{ color: 'var(--muted, #84848c)', fontSize: 14, lineHeight: 1.65, padding: '18px 6px' }}>
              <p style={{ margin: '0 0 12px', color: 'var(--fg, #ededf0)', fontSize: 15 }}>
                Ask anything — I can see your training, food, vitals and caffeine logs, and I can search the web.
                Or just say <strong style={{ color: 'var(--mint, #6EE7B7)' }}>&ldquo;Hey Coach&rdquo;</strong> from anywhere on the dashboard.
              </p>
              {['How recovered am I — should tomorrow be a hard session?',
                'What should I eat tonight to hit my protein target?',
                'Why might my HRV be trending down this week?'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', margin: '0 0 8px',
                    background: 'rgba(255,255,255,.04)', border: '1px solid var(--border, #1d1d22)',
                    color: 'var(--fg, #ededf0)', borderRadius: 12, padding: '10px 13px', fontSize: 13.5, cursor: 'pointer',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ margin: '0 0 14px', display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div
                style={
                  m.role === 'user'
                    ? {
                        maxWidth: '85%', background: 'rgba(110,231,183,.12)', border: '1px solid rgba(110,231,183,.25)',
                        color: 'var(--fg, #ededf0)', borderRadius: '14px 14px 4px 14px', padding: '9px 13px',
                        fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                      }
                    : {
                        maxWidth: '95%', color: m.error ? 'var(--warn, #f5c451)' : 'var(--fg, #d9d9de)',
                        fontSize: 14, lineHeight: 1.62,
                      }
                }
              >
                {m.role === 'user' ? m.text : <MdText text={m.text} />}
                {m.role === 'assistant' && !!m.sources?.length && (
                  <div style={{ marginTop: 2, paddingTop: 8, borderTop: '1px solid var(--border, #1d1d22)' }}>
                    {m.sources.map((s) => (
                      <a
                        key={s.url}
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: 'block', color: 'var(--muted, #84848c)', fontSize: 12,
                          margin: '3px 0', textDecoration: 'none', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        ↗ {s.title || s.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {status && (
            <div style={{ color: 'var(--mint, #6EE7B7)', fontFamily: 'var(--mono, monospace)', fontSize: 12, margin: '0 0 14px', opacity: 0.85 }}>
              {status}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          style={{
            display: 'flex', gap: 8,
            // pad the composer up past the home indicator (viewportFit:'cover'),
            // else the input + Ask button sit under it at the base of the sheet
            padding: '10px 12px calc(12px + env(safe-area-inset-bottom))',
            borderTop: '1px solid var(--border, #1d1d22)',
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Ask your coach…"
            rows={input.includes('\n') ? 3 : 1}
            style={{
              flex: 1, resize: 'none', background: 'rgba(255,255,255,.04)',
              border: '1px solid var(--border, #2a2a31)', color: 'var(--fg, #ededf0)',
              borderRadius: 12, padding: '11px 13px', font: 'inherit', fontSize: 14, outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            style={{
              background: busy || !input.trim() ? 'rgba(110,231,183,.25)' : 'var(--mint, #6EE7B7)',
              color: '#04140d', border: 'none', borderRadius: 12, padding: '0 18px',
              fontWeight: 600, fontSize: 14, cursor: busy || !input.trim() ? 'default' : 'pointer',
            }}
          >
            {busy ? '…' : 'Ask'}
          </button>
        </form>
      </aside>
    </>
  )

  // the panel only ever mounts from a click, so document is always there — the
  // guard is just so a server render can never touch it
  return typeof document === 'undefined' ? null : createPortal(sheet, document.body)
}
