// MIA-HYGIENE.6 — channel message-length limits.
//
// Meta rejects a WhatsApp text body over 4096 characters and an Instagram DM
// over 1000, and neither sender clamped: sendTextMessage posted the body
// verbatim, so an over-long message threw at the API and the customer got
// silence (plus a debounced dead-air push to staff hours later).
//
// A normal agent reply can't reach it — max_tokens is 600 — but two paths can:
// the truncation-retry re-runs the turn at 1000 tokens, and every proactive /
// operator-authored copy path renders text nobody length-checks. Splitting at
// the channel boundary covers all of them at once, rather than teaching each
// caller about Meta's limits.

// Below Meta's real ceilings, leaving room for any wrapper the caller adds.
export const WHATSAPP_TEXT_LIMIT = 3900
export const INSTAGRAM_TEXT_LIMIT = 900

// Only accept a boundary in the back half of the window — otherwise an early
// full stop would produce a two-word part followed by a wall of text.
const MIN_BOUNDARY_RATIO = 0.5

/**
 * Split text into parts that each fit within maxChars, preferring the most
 * natural break available: paragraph, then sentence, then word, then a hard
 * cut for an unbroken run. Pure.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]} always at least one part
 */
export function splitMessageText(text, maxChars) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return [s]

  const parts = []
  let rest = s
  const floor = Math.floor(maxChars * MIN_BOUNDARY_RATIO)

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)

    let cut = window.lastIndexOf('\n\n')
    if (cut < floor) {
      const sentence = window.lastIndexOf('. ')
      // +1 keeps the full stop with the sentence it ends.
      cut = sentence >= 0 ? sentence + 1 : -1
    }
    if (cut < floor) cut = window.lastIndexOf(' ')
    // No usable boundary (one long unbroken run): hard-cut at the limit
    // rather than emit a part the API will reject.
    if (cut < floor) cut = maxChars

    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }

  if (rest) parts.push(rest)
  return parts
}
