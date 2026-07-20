/**
 * Pure "Hey Coach" wake-phrase parsing — no DOM, no SpeechRecognition, so it's
 * trivial to unit-test. Used by components/VoiceBadge.tsx.
 */

const WAKE_RE = /\b(?:hey|ok|okay)[, ]+coach\b/i

/**
 * Does `transcript` contain the wake phrase, and if so what (if anything)
 * follows it in the same utterance? Returns null when the phrase isn't present.
 * `rest` is '' when the speaker said only the wake phrase (e.g. "Hey Coach"),
 * meaning the caller should open a short follow-up listening window.
 */
export function parseWake(transcript: string): { rest: string } | null {
  const m = WAKE_RE.exec(transcript)
  if (!m) return null
  const rest = transcript
    .slice(m.index + m[0].length)
    .trim()
    .replace(/^[,.!?\s]+/, '')
  return { rest }
}
