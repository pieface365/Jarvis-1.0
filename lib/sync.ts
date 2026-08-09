'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Optional cross-device sync for tile data.
 *
 * The base is zero-backend by default: a tile's `Vitality.save()` data lives in
 * the browser (localStorage). If the forker adds their OWN Supabase project (two
 * public keys in Vercel), tile data is ALSO written to a single `tile_data` table
 * — so opening the same site on another device (their phone) loads the same data.
 *
 * No login: the deployment is personal, so the anon key + an open policy on the
 * owner's own project is the whole model. If the keys are absent, everything here
 * no-ops and the app stays purely local.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let client: SupabaseClient | null = null

/** Whether cross-device sync is configured (both public keys present). */
export const syncEnabled = (): boolean => !!(url && anonKey)

function syncClient(): SupabaseClient | null {
  if (!url || !anonKey) return null
  if (!client) client = createClient(url, anonKey)
  return client
}

/** Push a tile's data to the owner's Supabase. Best-effort; returns false on any failure. */
export async function syncSave(tileId: string, data: unknown, isoNow: string): Promise<boolean> {
  const c = syncClient()
  if (!c) return false
  try {
    const { error } = await c
      .from('tile_data')
      .upsert({ tile_id: tileId, data, updated_at: isoNow }, { onConflict: 'tile_id' })
    return !error
  } catch {
    return false
  }
}

/** Read a tile's data from Supabase, or null if unconfigured / missing / offline. */
export async function syncLoad(tileId: string): Promise<unknown | null> {
  const c = syncClient()
  if (!c) return null
  try {
    const { data, error } = await c.from('tile_data').select('data').eq('tile_id', tileId).maybeSingle()
    if (error) return null
    return data?.data ?? null
  } catch {
    return null
  }
}

/* ── Closet photo storage ─────────────────────────────────────────────────
   Item photos are too big to keep inline in the tile_data blob at scale, so
   when Supabase is configured they go to a public Storage bucket ('closet')
   and the tile stores only the returned URL. Needs supabase/closet-storage.sql
   run once (bucket + open anon policies, same personal-instance model as the
   tile_data table). If unconfigured or it fails, the tile falls back to an
   inline base64 thumbnail — the feature degrades, never breaks. */
const CLOSET_BUCKET = 'closet'

/** Upload a data-URL image to the closet bucket; returns its public URL or null. */
export async function uploadPhoto(dataUrl: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const c = syncClient()
  if (!c) return { ok: false, error: 'unconfigured' }
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '')
  if (!m) return { ok: false, error: 'bad_image' }
  try {
    const bin = atob(m[2])
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const path = `items/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await c.storage.from(CLOSET_BUCKET).upload(path, bytes, { contentType: `image/${m[1]}`, upsert: false })
    if (error) return { ok: false, error: 'upload_failed' }
    const { data } = c.storage.from(CLOSET_BUCKET).getPublicUrl(path)
    return data?.publicUrl ? { ok: true, url: data.publicUrl } : { ok: false, error: 'upload_failed' }
  } catch {
    return { ok: false, error: 'upload_failed' }
  }
}

/** Best-effort delete of a previously uploaded closet photo by its public URL. */
export async function deletePhoto(url: string): Promise<void> {
  const c = syncClient()
  if (!c || typeof url !== 'string') return
  const marker = `/${CLOSET_BUCKET}/`
  const i = url.indexOf(marker)
  if (i < 0) return
  const path = url.slice(i + marker.length)
  if (!path) return
  try {
    await c.storage.from(CLOSET_BUCKET).remove([path])
  } catch {
    /* best-effort */
  }
}

/** A tile document stored in the owner's Supabase (built from Claude via the MCP connector). */
export interface RemoteTile {
  html: string
  name: string | null
}

/**
 * Read every MCP-built tile from the owner's Supabase, keyed by slot. Returns an
 * empty object if sync is unconfigured / offline. The dashboard prefers these over
 * the static public/tiles files, so a tile made from Claude — on the laptop or the
 * phone — appears without a redeploy. Requires the `tiles` table (supabase/tiles.sql).
 */
export async function syncLoadTiles(): Promise<Record<string, RemoteTile>> {
  const c = syncClient()
  if (!c) return {}
  try {
    const { data, error } = await c.from('tiles').select('slot, html, name')
    if (error || !data) return {}
    const map: Record<string, RemoteTile> = {}
    for (const row of data as Array<{ slot: string; html: string; name: string | null }>) {
      if (row.slot && typeof row.html === 'string' && row.html.trim()) {
        map[row.slot] = { html: row.html, name: row.name ?? null }
      }
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Write a tile into the owner's Supabase `tiles` table (the "+ New tile" button /
 * paste box). Same store the MCP connector writes to, so a tile made in the browser
 * and one made from Claude land in the same place. Returns false if unconfigured or
 * the write fails (e.g. tiles.sql not run yet).
 */
export async function syncSaveTile(slot: string, html: string, name?: string): Promise<boolean> {
  const c = syncClient()
  if (!c) return false
  try {
    const { error } = await c
      .from('tiles')
      .upsert({ slot, html, name: name ?? null, updated_at: new Date().toISOString() }, { onConflict: 'slot' })
    return !error
  } catch {
    return false
  }
}

/**
 * Wipe the owner's cloud data — every tile's saved data AND every tile they built
 * (the connector / "+ New tile" store). Used by the dashboard's Reset button. No-op
 * if sync is unconfigured. Best-effort; never throws.
 */
export async function syncWipe(): Promise<void> {
  const c = syncClient()
  if (!c) return
  try {
    // PostgREST refuses an unfiltered delete, so match every real row.
    await c.from('tile_data').delete().neq('tile_id', '')
    await c.from('tiles').delete().neq('slot', '')
  } catch {
    /* best-effort */
  }
}
