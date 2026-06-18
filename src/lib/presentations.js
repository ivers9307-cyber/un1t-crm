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
