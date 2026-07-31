# Vitality / Jarvis — iOS Lock Screen widget

A small live widget for your iPhone Lock Screen showing recovery, sleep, today's
fuel, and today's training session. It's powered by the free **Scriptable** app,
which runs the JavaScript below and renders it as a widget.

iOS doesn't let a website put a widget on the Lock Screen — only a native app or
a script host like Scriptable can. The script calls a tiny read-only endpoint,
[`/api/widget`](../app/api/widget/route.ts), authenticated with a bearer token
(the browser password gate can't be used from a widget).

## One-time server setup

1. In **Vercel → your project → Settings → Environment Variables**, add
   `WIDGET_TOKEN` = any long random secret (e.g. a password-manager string).
   Save and let it redeploy.
2. That's it — the endpoint is now live at
   `https://<your-domain>/api/widget` and returns `503 not_configured` until the
   token is set, `401 unauthorized` without the right bearer.

## Phone setup

1. Install **Scriptable** from the App Store (free).
2. Open Scriptable → **＋** (new script) → paste the script below.
3. Edit the two constants at the top:
   - `BASE_URL` — your dashboard's stable URL (e.g. `https://jarvis-1-0.vercel.app`).
   - `TOKEN` — the exact `WIDGET_TOKEN` you set in Vercel.
4. Tap ▶︎ to run it once inside Scriptable — you should see a preview with your
   numbers. If instead you see a small error word, it tells you what's wrong:
   - `not_configured` — `WIDGET_TOKEN` isn't set in Vercel yet (or not redeployed).
   - `bad_token` — the script's `TOKEN` doesn't match Vercel's `WIDGET_TOKEN`.
   - `no_token` — the script isn't sending the token (check the `TOKEN` line).
   - `unreachable` — wrong `BASE_URL`, or no network.
5. Name the script (e.g. "Vitality") and close.
6. Lock your phone → long-press the Lock Screen → **Customize** → tap the widget
   area under the clock → add a **Scriptable** widget → tap it → choose **Script:
   Vitality** and **When Interacting: Run Script** (or Show in App). Done.

iOS decides how often Lock Screen widgets refresh (typically every 15–30 min, and
more when you look at it); the script also requests a ~20-minute refresh.

## The script

```javascript
// Vitality / Jarvis — iOS Lock Screen widget (Scriptable)
// Edit BASE_URL and TOKEN, then add an "accessoryRectangular" Scriptable widget
// to your Lock Screen and point it at this script.

const BASE_URL = "https://YOUR-DOMAIN.vercel.app" // your dashboard's stable URL
const TOKEN = "YOUR_WIDGET_TOKEN"                 // must match WIDGET_TOKEN in Vercel

const tz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { return "America/New_York" }
})()

async function getData() {
  const req = new Request(`${BASE_URL}/api/widget?tz=${encodeURIComponent(tz)}`)
  req.headers = { Authorization: `Bearer ${TOKEN}` }
  req.timeoutInterval = 15
  return await req.loadJSON()
}

function fmtSleep(h) {
  if (h == null) return "—"
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${hh}h${String(mm).padStart(2, "0")}`
}

function addLine(stack, text, size, bold) {
  const t = stack.addText(text)
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size)
  t.lineLimit = 1
  t.minimumScaleFactor = 0.7
  return t
}

async function build() {
  const w = new ListWidget()
  w.setPadding(4, 6, 4, 6)
  w.url = BASE_URL // tapping the widget opens the dashboard, not the Scriptable app

  let d = null
  try { d = await getData() } catch (e) { d = null }

  if (!d || d.ok === false) {
    addLine(w, "Vitality", 13, true)
    addLine(w, d && d.error ? String(d.error) : "unreachable", 11, false)
    w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000)
    return w
  }

  const rec = d.recovery != null ? `${d.recovery}%` : "—"
  const hrv = d.hrv != null ? `${Math.round(d.hrv)}` : "—"
  const rhr = d.rhr != null ? `${Math.round(d.rhr)}` : "—"
  const kcal = `${d.fuel.cal}/${d.fuel.calGoal}`
  const prot = `${d.fuel.protein}/${d.fuel.proteinGoal}P`
  const wo = d.workout && d.workout.label ? d.workout.label : "—"

  addLine(w, `Rec ${rec} · HRV ${hrv}`, 13, true)
  addLine(w, `Sleep ${fmtSleep(d.sleepHours)} · RHR ${rhr}`, 11, false)
  addLine(w, `${kcal} kcal · ${prot}`, 11, false)
  addLine(w, `Next: ${wo}`, 11, false)

  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000)
  return w
}

const widget = await build()
if (config.runsInWidget) {
  Script.setWidget(widget)
} else {
  await widget.presentAccessoryRectangular() // preview when run inside Scriptable
}
Script.complete()
```

## Notes

- The training split is a fixed weekly program mirrored from the Train tile
  (Mon Climb·Limit, Tue Lift·Push, Wed Climb·Technique, Thu Lift·Legs,
  Fri Climb·Projecting, Sat Lift·Pull, Sun Rest). If you rework the program in
  the tile, update `WORKOUT` in [`/api/widget`](../app/api/widget/route.ts).
- Recovery is computed the same way the Vitals tile computes it (HRV 50% /
  RHR 25% / sleep 25% / feel), from your most recent vitals entry.
- Fuel totals are for "today" in the timezone the widget passes (`tz`),
  defaulting to `America/New_York`.
- The token is a shared secret in plain text on your phone; treat it like a
  password. To rotate it, change `WIDGET_TOKEN` in Vercel and the script.
```
