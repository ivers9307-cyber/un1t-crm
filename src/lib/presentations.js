// PRESENT — pure helpers for the slideshow feature. No IO.
//
// Used by the slide-upload route (ordering), the advance route + public
// viewer (index clamping), and the viewer's change detection.

/**
 * Return a new array sorted by `.name` with numeric-aware comparison so
 * PowerPoint's "Slide1.JPG … Slide10.JPG" exports order correctly
 * (a plain lexicographic sort puts Slide10 before Slide2). Stable + pure.
 */
export function naturalSortByName(items) {
  return [...(items || [])].sort((a, b) =>
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/** Clamp a slide index into [0, count-1]; 0 for an empty deck or bad input. */
export function clampIndex(index, count) {
  const n = Number(index)
  const c = Number(count)
  if (!Number.isFinite(c) || c <= 0) return 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(Math.trunc(n), c - 1))
}

/** True when a polled `version` differs from the last one the viewer saw. */
export function hasAdvanced(prevVersion, nextVersion) {
  return prevVersion !== nextVersion
}

/**
 * PRESENTSAFE.1 (October audit A18) — a reorder must name every slide of the
 * deck exactly once: an order with a missing, repeated or foreign id would
 * leave two slides on one position or drop one from the show.
 * @param {string[]} order the requested slide ids, first to last
 * @param {string[]} deckSlideIds every slide id the deck holds
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateDeckOrder(order, deckSlideIds) {
  const deck = new Set(deckSlideIds)
  const seen = new Set()
  for (const id of order) {
    if (!deck.has(id)) return { ok: false, error: 'The order names a slide that is not in this presentation.' }
    if (seen.has(id)) return { ok: false, error: 'The order names a slide twice.' }
    seen.add(id)
  }
  if (seen.size !== deck.size) return { ok: false, error: 'The order leaves out a slide. Refresh and try again.' }
  return { ok: true }
}
