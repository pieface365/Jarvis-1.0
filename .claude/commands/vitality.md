---
description: Install the full Vitality dashboard — load the complete set of tiles we built onto your blank board.
---

The person has a **blank Vitality dashboard** (the "see the vision" board, no tiles yet). Running
`/vitality` means: *"skip building from scratch — give me the whole dashboard the Vitality team built."*
Your job is to install the full tile set onto their board.

Tone: warm, plain-language. Explain what you're doing in a sentence, do it, then tell them to look.

## What "the full dashboard" is

The complete set of ready-made tiles ships bundled with this project in the **`tiles-library/`** folder
(Train, Fuel, Vitals, Vee, Peak, Brand, Finance). Installing = copying them into `public/tiles/`, which
is the folder the board reads. A fresh board is blank because that folder starts empty; this fills it.

## Step 1 — Install the tiles

First make sure the target folder exists, then copy the whole library in:

```bash
mkdir -p public/tiles
cp tiles-library/*.html public/tiles/
```

If `tiles-library/` isn't there (an older or hand-trimmed copy), pull it straight from the public repo
instead — same result:

```bash
npx --yes degit RowanThistlebrooke/vitality-base/tiles-library public/tiles --force
```

Then confirm what landed: `ls public/tiles` should list the seven `.html` tiles.

## Step 2 — Look at it

Tell them to **reload http://localhost:3000** (or start it with `npm run dev` if it isn't running). The
blank "see the vision" board is now the **full Vitality dashboard** — every tile filled and live. Clicking
a tile opens the real thing.

## Step 3 — Make it theirs

Say it plainly: this is a starting point, not a cage.
- **Don't want a tile?** Delete its file in `public/tiles/` (e.g. `rm public/tiles/finance.html`) and it
  disappears from the board on reload.
- **Want to change one?** Rebuild it your way with `/tile <slot>` (slots: `train, fuel, vitals, vee, brand,
  peak, finance`), or just ask me to edit `public/tiles/<slot>.html`.

## Step 4 — Put it live (if their dashboard is already on GitHub)

If they've already pushed this dashboard to GitHub (from the setup step), offer to ship it:

```bash
git add -A
git commit -m "feat: install the full Vitality dashboard"
git push
```

Vercel auto-deploys on push, so the full dashboard goes live at their `…vercel.app` in a minute. If it's
not on GitHub yet, tell them that's the setup step first — this just filled the board locally.
