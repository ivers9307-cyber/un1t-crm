// Pure helpers for the reviews carousel — visibility filter + marquee sizing.
// No IO — unit-tested in reviews.test.js. (The Google Business Profile API
// sync was retired; reviews in `google_reviews` are now populated manually.)

// The carousel predicate, applied in JS so the renderer and tests share it.
export function filterVisibleReviews(rows, minRating) {
  const min = Number.isFinite(minRating) ? minRating : 4
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => !r.hidden && r.comment && r.rating >= min
  )
}

// Marquee scroll duration. Longer track (more cards) → longer duration so
// the px/sec speed stays roughly constant. Floor keeps a 1-card strip moving.
const SECONDS_PER_CARD = { slow: 9, normal: 6, fast: 4 }
export function marqueeDurationSeconds(speed, count) {
  const per = SECONDS_PER_CARD[speed] || SECONDS_PER_CARD.normal
  return Math.max(per * 2, per * (count || 0))
}
