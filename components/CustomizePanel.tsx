'use client'

import { useState, type CSSProperties } from 'react'
import {
  dashboardChrome,
  DEFAULT_CHROME,
  WALLPAPER_ACCENTS,
  GRADIENT_PRESETS,
  type DashboardChrome,
  type Background,
} from '@/lib/tiles/dashboardChrome'

/**
 * The dashboard's edit surface — every piece of chrome becomes clickable:
 * greeting wording/name/size, the date line, the gem, and the wallpaper
 * (world tint, gradient presets, solid color). Writes through dashboardChrome
 * and lifts the fresh chrome up so the page repaints live. "Arrange tiles"
 * hands off to the grid's edit mode (move + resize on every tile).
 */

interface Props {
  userId: string
  chrome: DashboardChrome
  onChange: (c: DashboardChrome) => void
  onClose: () => void
  arranging: boolean
  onToggleArrange: () => void
}

const panel: CSSProperties = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(340px, 92vw)', zIndex: 70,
  background: 'rgba(10,10,12,.92)', backdropFilter: 'blur(22px) saturate(1.2)', WebkitBackdropFilter: 'blur(22px) saturate(1.2)',
  borderLeft: '1px solid rgba(255,255,255,.09)', padding: '22px 20px 32px', overflowY: 'auto',
  color: 'var(--fg, #ededf0)', fontSize: 13.5,
}
const h: CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace', textTransform: 'uppercase', letterSpacing: '.18em', fontSize: 10, fontWeight: 600, color: '#84848c', margin: '26px 0 10px' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0' }
const seg: CSSProperties = { display: 'inline-flex', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 999, padding: 3, gap: 2 }
const segBtn = (on: boolean): CSSProperties => ({
  appearance: 'none', border: 0, cursor: 'pointer', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 600,
  background: on ? '#6EE7B7' : 'transparent', color: on ? '#04140d' : '#84848c',
})
const textInput: CSSProperties = { width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)', color: 'inherit', borderRadius: 10, padding: '9px 11px', font: 'inherit', outline: 'none' }

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={{
      width: 40, height: 22, borderRadius: 999, border: '1px solid rgba(255,255,255,.15)', cursor: 'pointer', position: 'relative',
      background: on ? '#6EE7B7' : 'rgba(255,255,255,.06)', transition: 'background .2s', flex: 'none',
    }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: '50%', background: on ? '#04140d' : '#84848c', transition: 'left .2s' }} />
    </button>
  )
}

export default function CustomizePanel({ userId, chrome, onChange, onClose, arranging, onToggleArrange }: Props) {
  const [custom, setCustom] = useState(chrome.greeting.text)
  const g = chrome.greeting
  const d = chrome.date
  const bg = chrome.background

  const patch = (p: Partial<DashboardChrome>) => onChange(dashboardChrome.update(userId, p))
  const patchGreeting = (p: Partial<DashboardChrome['greeting']>) => patch({ greeting: { ...g, ...p } })
  const setBg = (b: Background) => onChange(dashboardChrome.setBackground(userId, b))

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 69, background: 'rgba(0,0,0,.35)' }} />
      <aside style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 21 }}>Customize</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: '#84848c', fontSize: 20, cursor: 'pointer', padding: 4 }}>×</button>
        </div>

        {/* ── layout ── */}
        <div style={h}>Tiles</div>
        <button type="button" onClick={onToggleArrange} style={{
          width: '100%', padding: '11px 14px', borderRadius: 12, cursor: 'pointer', fontWeight: 600, fontSize: 13.5,
          background: arranging ? '#6EE7B7' : 'rgba(110,231,183,.08)', color: arranging ? '#04140d' : '#6EE7B7',
          border: '1px solid rgba(110,231,183,.4)',
        }}>
          {arranging ? 'Done arranging' : 'Arrange tiles — move + resize'}
        </button>

        {/* ── greeting ── */}
        <div style={h}>Greeting</div>
        <div style={seg}>
          <button type="button" style={segBtn(g.mode === 'auto')} onClick={() => patchGreeting({ mode: 'auto' })}>Time of day</button>
          <button type="button" style={segBtn(g.mode === 'custom')} onClick={() => patchGreeting({ mode: 'custom' })}>Custom</button>
        </div>
        {g.mode === 'custom' && (
          <input
            style={{ ...textInput, marginTop: 10 }}
            value={custom}
            placeholder="Your greeting…"
            onChange={(e) => { setCustom(e.target.value); patchGreeting({ text: e.target.value }) }}
          />
        )}
        <div style={row}><span>Show my name</span><Toggle on={g.showName} onClick={() => patchGreeting({ showName: !g.showName })} /></div>
        <div style={row}><span>Accent the name</span><Toggle on={g.accentName} onClick={() => patchGreeting({ accentName: !g.accentName })} /></div>
        <div style={row}>
          <span>Size</span>
          <input type="range" min={0.8} max={1.3} step={0.05} value={g.scale}
            onChange={(e) => patchGreeting({ scale: Number(e.target.value) })} style={{ width: 130, accentColor: '#6EE7B7' }} />
        </div>

        {/* ── date + gem ── */}
        <div style={h}>Header</div>
        <div style={row}><span>Show the date</span><Toggle on={d.show} onClick={() => patch({ date: { ...d, show: !d.show } })} /></div>
        {d.show && (
          <div style={row}>
            <span>Format</span>
            <div style={seg}>
              <button type="button" style={segBtn(d.format === 'full')} onClick={() => patch({ date: { ...d, format: 'full' } })}>Full</button>
              <button type="button" style={segBtn(d.format === 'today')} onClick={() => patch({ date: { ...d, format: 'today' } })}>Short</button>
            </div>
          </div>
        )}
        <div style={row}><span>Show the gem</span><Toggle on={chrome.gem.show} onClick={() => patch({ gem: { ...chrome.gem, show: !chrome.gem.show } })} /></div>

        {/* ── wallpaper ── */}
        <div style={h}>Wallpaper</div>
        <div style={seg}>
          <button type="button" style={segBtn(bg.mode === 'world')} onClick={() => setBg({ mode: 'world', accent: bg.mode === 'world' ? bg.accent : '#6EE7B7', particles: 24, mountains: true, speed: 1 })}>World</button>
          <button type="button" style={segBtn(bg.mode === 'gradient')} onClick={() => setBg({ mode: 'gradient', ...GRADIENT_PRESETS[0] })}>Gradient</button>
          <button type="button" style={segBtn(bg.mode === 'solid')} onClick={() => setBg({ mode: 'solid', color: '#07090b' })}>Solid</button>
        </div>

        {bg.mode === 'world' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {WALLPAPER_ACCENTS.map((a) => (
              <button key={a.hex} type="button" title={a.name} onClick={() => setBg({ ...bg, accent: a.hex })} style={{
                width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', background: a.hex,
                border: bg.accent === a.hex ? '2px solid #fff' : '2px solid transparent',
                boxShadow: bg.accent === a.hex ? `0 0 14px ${a.hex}88` : 'none',
              }} />
            ))}
          </div>
        )}
        {bg.mode === 'gradient' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {GRADIENT_PRESETS.map((p) => (
              <button key={p.name} type="button" title={p.name} onClick={() => setBg({ mode: 'gradient', c1: p.c1, c2: p.c2, angle: p.angle })} style={{
                width: 44, height: 30, borderRadius: 8, cursor: 'pointer',
                background: `linear-gradient(${p.angle}deg, ${p.c1}, ${p.c2})`,
                border: bg.c1 === p.c1 ? '2px solid #fff' : '1px solid rgba(255,255,255,.15)',
              }} />
            ))}
          </div>
        )}
        {bg.mode === 'solid' && (
          <div style={{ ...row, marginTop: 6 }}>
            <span>Color</span>
            <input type="color" value={bg.color} onChange={(e) => setBg({ mode: 'solid', color: e.target.value })}
              style={{ width: 44, height: 30, border: 'none', background: 'none', cursor: 'pointer' }} />
          </div>
        )}

        {/* ── reset ── */}
        <div style={h}>Reset</div>
        <button type="button" onClick={() => { onChange(dashboardChrome.reset(userId)); setCustom(DEFAULT_CHROME.greeting.text) }} style={{
          background: 'none', border: '1px solid rgba(255,255,255,.15)', color: '#84848c', borderRadius: 10,
          padding: '9px 14px', cursor: 'pointer', fontSize: 12.5,
        }}>
          Reset greeting + wallpaper
        </button>
      </aside>
    </>
  )
}
