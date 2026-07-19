'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * CoachPanel — the dashboard's AI coach chat, opened from the dock.
 *
 * Lives at host level (not a sealed tile) because the coach spans every tile's
 * data: the host page is same-origin, so the gate cookie rides along to
 * /api/coach and the server reads the tile data itself. The transcript
 * persists in localStorage so a conversation survives reloads.
 */

type Source = { url: string; title: string | null }
type Msg = { role: 'user' | 'assistant'; text: string; sources?: Source[]; error?: boolean }

const STORE_KEY = 'vitality:coach:chat'
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

/* ── the panel ──────────────────────────────────────────────────────────── */

export default function CoachPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setMessages(loadChat())
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // keep the newest message in view while the answer streams in
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  /** Mutate the trailing assistant message (the one being streamed). */
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMessages((cur) => {
      const next = [...cur]
      next[next.length - 1] = fn(next[next.length - 1])
      saveChat(next)
      return next
    })

  const send = async () => {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setBusy(true)
    setStatus('thinking…')
    const history = [...messages, { role: 'user' as const, text: q }]
    setMessages([...history, { role: 'assistant', text: '' }])
    saveChat(history)

    const ac = new AbortController()
    abortRef.current = ac
    let failed: string | null = null
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
              patchLast((m) => ({ ...m, text: m.text + chunk }))
            } else if (ev.t === 'status') {
              setStatus('searching the web…')
            } else if (ev.t === 'sources' && Array.isArray(ev.v)) {
              const srcs = ev.v as Source[]
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
    if (!ac.signal.aborted) {
      if (failed) {
        const msg = ERROR_TEXT[failed] ?? ERROR_TEXT.api_error
        patchLast((m) => (m.text ? m : { ...m, text: msg, error: true }))
      }
      setStatus(null)
      setBusy(false)
    }
  }

  const clear = () => {
    setMessages([])
    try {
      window.localStorage.removeItem(STORE_KEY)
    } catch {
      /* ignore */
    }
  }

  return (
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
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 120,
          width: 'min(480px, 100vw)', display: 'flex', flexDirection: 'column',
          background: 'var(--bg, #0a0b0a)', borderLeft: '1px solid var(--border, #1d1d22)',
          boxShadow: '-18px 0 60px rgba(0,0,0,.55)',
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
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

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 8px' }}>
          {messages.length === 0 && (
            <div style={{ color: 'var(--muted, #84848c)', fontSize: 14, lineHeight: 1.65, padding: '18px 6px' }}>
              <p style={{ margin: '0 0 12px', color: 'var(--fg, #ededf0)', fontSize: 15 }}>
                Ask anything — I can see your training, food, vitals and caffeine logs, and I can search the web.
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
          style={{ display: 'flex', gap: 8, padding: '10px 12px 12px', borderTop: '1px solid var(--border, #1d1d22)' }}
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
}
