import type { TileSize } from './tileSkin'

/**
 * homeLayout holds WHERE the slot tiles sit and HOW BIG they are — the user's
 * arrangement, separate from dashboardChrome (greeting/wallpaper) and tileSkin
 * (custom-tile looks). v1 is localStorage per user, same swap seam as the rest.
 *
 * Key:
 *   vitality:<userId>:homeLayout -> { order: string[], sizes: Record<slotId, TileSize> }
 */

export interface HomeLayout {
  order: string[]
  sizes: Record<string, TileSize>
}

const key = (userId: string) => `vitality:${userId}:homeLayout`
const hasStorage = () => typeof window !== 'undefined' && !!window.localStorage

function get(userId: string): HomeLayout {
  if (!hasStorage()) return { order: [], sizes: {} }
  try {
    const raw = window.localStorage.getItem(key(userId))
    const o = raw ? JSON.parse(raw) : null
    return {
      order: Array.isArray(o?.order) ? o.order.filter((v: unknown) => typeof v === 'string') : [],
      sizes: o?.sizes && typeof o.sizes === 'object' ? o.sizes : {},
    }
  } catch {
    return { order: [], sizes: {} }
  }
}

function set(userId: string, layout: HomeLayout): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(layout))
  } catch {
    /* quota / blocked. fail quiet */
  }
}

function reset(userId: string): void {
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(key(userId))
  } catch {
    /* fail quiet */
  }
}

/** The user's order first (unknown ids dropped), then any new slots appended in
 *  default order — a new tile always appears without touching saved layout. */
export function resolveOrder(saved: string[], defaults: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of saved) if (defaults.includes(id) && !seen.has(id)) { out.push(id); seen.add(id) }
  for (const id of defaults) if (!seen.has(id)) out.push(id)
  return out
}

export const homeLayout = { get, set, reset }
