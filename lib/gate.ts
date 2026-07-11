/**
 * Shared bits for the built-in password gate (see middleware.ts). Free
 * replacement for Vercel's paid production Deployment Protection: one
 * password, one long-lived httpOnly cookie. Edge-safe (crypto.subtle only).
 */

export const GATE_COOKIE = 'vt_gate'

/** The cookie value proving the password was entered: SHA-256 of a salted
 *  password. Not a session system — a personal single-user latch. */
export async function gateToken(password: string): Promise<string> {
  const data = new TextEncoder().encode('vitality-gate:' + password)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
