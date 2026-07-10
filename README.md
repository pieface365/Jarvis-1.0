# Vitality Base Dashboard

Your own personal dashboard, forkable in a couple of minutes. It is the exact
Vitality home screen: an animated poster grid over a living backdrop. Every tile is
an empty **slot** that you fill by following a step-by-step build (on Patreon) or by
building your own.

**No backend. No login. No accounts.** Fork it, deploy it, done.

---

## Deploy in 2 minutes

1. **Use this template** (green button on GitHub) to create your own repo.
2. **Deploy to Vercel**: import the repo and click Deploy. There are **no environment
   variables** to set.

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/RowanThistlebrooke/vitality-base)

That is it. Your dashboard is live.

### Make it yours

Edit one line in [`content/site.ts`](content/site.ts) to put your name in the
greeting:

```ts
export const site = { name: 'Your Name' }
```

### Level up: real saving (optional)

By default your data saves in the browser, per device. To sync across your phone and
laptop, add your own free Supabase project:

1. Create a project at https://supabase.com
2. In the SQL editor, run [`supabase/sync.sql`](supabase/sync.sql)
3. Add two env vars (in Vercel, and `.env.local` for local dev):

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Redeploy and your tiles save for real across devices. This is a single-user personal
setup with no login, so the anon key is public in the browser: treat the data as
not-secret, or add auth later.

## Run it locally

```bash
git clone <your-fork-url>
cd vitality-base
npm install
npm run dev
```

Then open http://localhost:3000. Requires Node 20+ (see `.nvmrc`).

---

## Filling the tiles

Click any tile and it opens a panel telling you how to build it. Each tile is a slot
that fills when a file exists at `public/tiles/<slot>.html`. Two ways to fill one:

- **Follow a build.** Each Patreon episode ships a slash command (e.g. `/logger`).
  Drop it into `.claude/commands/`, run it in Claude Code, and it writes the tile
  straight into the right slot. Commit, redeploy, and it appears.
- **Build your own.** Run [`/tile <slot>`](.claude/commands/tile.md) in Claude Code
  (or ask it to build a `<slot>` tile and save it to `public/tiles/<slot>.html`).

A tile is one self-contained HTML file. It saves its own data through the dashboard
bridge, `window.Vitality.save()` and `window.Vitality.load()`, which the dashboard
provides. Full contract: [`public/tiles/README.md`](public/tiles/README.md).

The slots: `train`, `fuel`, `vitals`, `vee`, `brand`, `peak`, `finance`.

---

## Talk to your dashboard (the connector)

Optional — but this is the magic. Connect Claude to your dashboard and it can **build
and edit tiles by talking**, with no copy-paste and no redeploy. Say *"make me a water
tile"* in Claude and it appears on your live dashboard on the next reload.

The connector is a personal, single-user MCP server baked into this same app
(`app/api/mcp`), so **deploying the dashboard already deployed the connector.** Three
one-time steps switch it on:

1. **Add a free Supabase** — this is where connector-built tiles live, so they sync
   across your devices. Create a project at https://supabase.com, then in the SQL
   editor run [`supabase/tiles.sql`](supabase/tiles.sql) (and
   [`supabase/sync.sql`](supabase/sync.sql) if you want per-tile data to sync too).
   Add two env vars, in Vercel **and** `.env.local` for local dev:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=your-project-url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```

2. **Set the connector password** — any long random string. Without it the connector
   stays disabled (returns 503). A second, **recommended** secret signs the OAuth
   tokens used by the claude.ai path below; if you skip it, it is derived from
   `MCP_TOKEN`, so `MCP_TOKEN` alone is enough to work.

   ```bash
   MCP_TOKEN=make-this-a-long-random-secret          # required — the connector password
   MCP_OAUTH_SECRET=another-long-random-secret        # recommended — signs OAuth tokens
   ```

   Redeploy so Vercel picks up the new vars.

3. **Connect Claude Code** — one command:

   ```bash
   claude mcp add --transport http vitality \
     https://YOUR-SITE.vercel.app/api/mcp/mcp \
     --header "Authorization: Bearer YOUR_MCP_TOKEN"
   ```

Now, in Claude Code: *"build a discipline-scoreboard tile in the vitals slot."* It uses
the connector and the tile shows up on your dashboard. The tools it exposes:
`list_slots`, `read_tile`, `create_tile` (also edits — it replaces a slot), and
`delete_tile`.

### Connect from claude.ai, Claude Desktop, or a scheduled task (OAuth)

Those clients can't send a static bearer token, so the same connector also speaks
**OAuth 2.1** — no extra setup, it's live as soon as `MCP_TOKEN` is set. To connect:

1. In claude.ai (or Claude Desktop): **Settings → Connectors → Add custom connector.**
2. Paste your MCP URL: `https://YOUR-SITE.vercel.app/api/mcp/mcp`
3. Claude discovers the OAuth server and opens **your site's authorize page**.
4. **Enter your `MCP_TOKEN`** and click Allow — that's the login. Connected.

Your `MCP_TOKEN` is the only thing that can authorize a connection, so treat that
authorize page like a password prompt: only enter your token when *you* started the
connect, and check the client host it names before allowing.

The flow is **stateless** — authorization codes and access tokens are short-lived
signed JWTs (PKCE-protected), so there are no OAuth tables to add. Discovery lives at
`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`;
the endpoints are under [`app/api/mcp/oauth`](app/api/mcp/oauth). Access tokens last
1h; to revoke everything, rotate `MCP_OAUTH_SECRET` (or `MCP_TOKEN`) and redeploy.

---

## Tech

Next.js 14 (App Router) · vanilla CSS · Three.js for the header gem · deployed on
Vercel. Zero-backend by default (tiles are static files, data lives in your browser);
add your own Supabase + set `MCP_TOKEN` to build tiles from Claude and sync across
devices via the connector (`app/api/mcp`).
