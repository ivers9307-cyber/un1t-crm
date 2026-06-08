// Pure helpers for normalizing + filtering Google reviews and sizing the
// marquee. No IO — unit-tested in reviews.test.js.

const STAR_WORDS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

// Google v4 reviews return starRating as a word enum (ONE..FIVE) or
// STAR_RATING_UNSPECIFIED. Map to an int; 0 means "drop it".
export function normalizeStarRating(word) {
  return STAR_WORDS[word] || 0
}

// Flatten a Google v4 review object into our google_reviews row shape.
export function normalizeReview(r) {
  return {
    google_review_id: r.reviewId || r.name || null,
    rating:           normalizeStarRating(r.starRating),
    comment:          r.comment || null,
    author_name:      r.reviewer?.displayName || null,
    author_photo_url: r.reviewer?.profilePhotoUrl || null,
    review_time:      r.createTime || null,
    reply_comment:    r.reviewReply?.comment || null,
  }
}

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
