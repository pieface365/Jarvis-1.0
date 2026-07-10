import { createMcpHandler } from 'mcp-handler'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

import { constantTimeEquals, looksLikeJwt, verifyAccessToken } from '../oauth/crypto'
import { MCP_SCOPE, mcpResourceUrl, oauthSecret, originOf, resourceMetadataUrl } from '../oauth/shared'

/**
 * The Vitality Base connector — a personal, single-user MCP server.
 *
 * It lets Claude build and edit your dashboard tiles by talking, with no
 * copy-paste and no redeploy: a tile written here lands in your Supabase `tiles`
 * table, and the dashboard reads it on load (see lib/sync.ts + DashboardGrid).
 *
 * Setup (all one-time):
 *   1. Add your own free Supabase (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY) and run
 *      supabase/tiles.sql — that's the store the tiles live in.
 *   2. Set MCP_TOKEN to any long secret string. It's the password for this
 *      connector; without it the endpoint is disabled (503).
 *   3. Connect from Claude Code (bearer token, no OAuth):
 *        claude mcp add --transport http vitality \
 *          https://YOUR-SITE.vercel.app/api/mcp/mcp \
 *          --header "Authorization: Bearer YOUR_MCP_TOKEN"
 *
 * Auth is DUAL:
 *   • Claude Code presents the raw MCP_TOKEN bearer (constant-time compared).
 *   • claude.ai / Claude Desktop / cloud tasks can't send a static bearer, so
 *     they connect via the OAuth 2.1 flow under app/api/mcp/oauth/* and present
 *     a signed access-token JWT here instead. See CONNECTOR.md.
 * A request with no/invalid auth gets a 401 carrying `WWW-Authenticate` with the
 * protected-resource-metadata URL, which is how claude.ai discovers the OAuth AS.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SLOTS = ['train', 'fuel', 'vitals', 'vee', 'brand', 'peak', 'finance'] as const

const MAX_TILE_HTML = 1024 * 1024 // 1MB — one tile can never be pathological

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true })

const NO_DB = fail(
  'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then run supabase/tiles.sql.',
)

/** Anon client (open RLS policy on a personal instance). Null if unconfigured. */
function db(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'list_slots',
      {
        title: 'List dashboard slots',
        description:
          'READ. List the seven dashboard tile slots (train, fuel, vitals, vee, brand, peak, finance) and whether each currently holds a tile.',
        inputSchema: {},
      },
      async (): Promise<ToolResult> => {
        const c = db()
        if (!c) return NO_DB
        const { data, error } = await c.from('tiles').select('slot')
        if (error) return fail('Could not read the tiles table. Did you run supabase/tiles.sql?')
        const filled = new Set((data ?? []).map((r: { slot: string }) => r.slot))
        return text(SLOTS.map((s) => `- ${s}${filled.has(s) ? ' — filled' : ' — empty'}`).join('\n'))
      },
    )

    server.registerTool(
      'read_tile',
      {
        title: 'Read a tile',
        description:
          'READ. Return the current sealed HTML of a slot so you can edit it. Empty slots return a note.',
        inputSchema: { slot: z.enum(SLOTS) },
      },
      async ({ slot }): Promise<ToolResult> => {
        const c = db()
        if (!c) return NO_DB
        const { data, error } = await c.from('tiles').select('html').eq('slot', slot).maybeSingle()
        if (error) return fail('Could not read that slot.')
        if (!data) return text(`Slot "${slot}" is empty. Use create_tile to fill it.`)
        return text(data.html as string)
      },
    )

    server.registerTool(
      'create_tile',
      {
        title: 'Create or replace a tile',
        description:
          'WRITE. Put a sealed, self-contained HTML tile into a dashboard slot, replacing any existing tile there (use this to edit too). The HTML MUST be one complete standalone document — all CSS and JS inline, no external requests, no network calls (it runs sandboxed with allow-scripts only). Match the look: near-black background, mint accent #6EE7B7, clean sans headings. To persist data it may call window.Vitality.save(data) / window.Vitality.load(). The tile appears on the dashboard on next reload.',
        inputSchema: {
          slot: z.enum(SLOTS),
          html: z.string().min(1).max(MAX_TILE_HTML).describe('The complete sealed tile HTML document'),
          name: z.string().min(1).max(60).optional().describe('Optional display name'),
        },
      },
      async ({ slot, html, name }): Promise<ToolResult> => {
        const c = db()
        if (!c) return NO_DB
        const { error } = await c
          .from('tiles')
          .upsert(
            { slot, html, name: name ?? null, updated_at: new Date().toISOString() },
            { onConflict: 'slot' },
          )
        if (error) return fail('Could not save the tile.')
        return text(`Saved the "${slot}" tile. Reload your dashboard to see it.`)
      },
    )

    server.registerTool(
      'delete_tile',
      {
        title: 'Clear a tile',
        description:
          'WRITE. Remove the live tile from a slot. The slot reverts to any committed static file, or to empty.',
        inputSchema: { slot: z.enum(SLOTS) },
      },
      async ({ slot }): Promise<ToolResult> => {
        const c = db()
        if (!c) return NO_DB
        const { error } = await c.from('tiles').delete().eq('slot', slot)
        if (error) return fail('Could not clear that slot.')
        return text(`Cleared the "${slot}" slot.`)
      },
    )
  },
  { serverInfo: { name: 'vitality-base', version: '0.1.0' } },
  { basePath: '/api/mcp', sessionIdGenerator: undefined, disableSse: true },
)

function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/** 401 that tells an OAuth client where to discover the authorization server
 *  (RFC 9728). claude.ai reads `resource_metadata` here, fetches it, then runs
 *  the OAuth flow — that is how it bootstraps a connection with no static token. */
function unauthorized(req: Request): Response {
  const metadata = resourceMetadataUrl(originOf(req))
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${metadata}"`,
    },
  })
}

/** True if the bearer authorizes this request via EITHER path:
 *  the raw MCP_TOKEN (Claude Code) or a valid OAuth access-token JWT (claude.ai). */
function isAuthorized(req: Request, expected: string): boolean {
  const provided = bearerToken(req)
  if (!provided) return false

  // Path 1 — Claude Code: raw shared secret, constant-time.
  if (constantTimeEquals(provided, expected)) return true

  // Path 2 — OAuth: a signed access token bound (aud) to this resource.
  if (looksLikeJwt(provided)) {
    const secret = oauthSecret()
    if (!secret) return false
    const verified = verifyAccessToken(provided, {
      secret,
      expectedAud: mcpResourceUrl(originOf(req)),
    })
    if (verified && verified.scope.split(/\s+/).includes(MCP_SCOPE)) return true
  }

  return false
}

async function handler(req: Request): Promise<Response> {
  const expected = process.env.MCP_TOKEN
  if (!expected) {
    return Response.json(
      { error: 'connector_not_configured', hint: 'Set MCP_TOKEN in your environment to enable the connector.' },
      { status: 503 },
    )
  }
  if (!isAuthorized(req, expected)) return unauthorized(req)
  return mcpHandler(req)
}

export { handler as GET, handler as POST }
