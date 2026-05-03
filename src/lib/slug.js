// Slug generation — lowercase kebab-case, ASCII only.
// Pure helper, exported so route validation logic can be tested
// without mocking the route's full plumbing.
//
// Used today for organizations.slug (mig 079); same shape we use
// inline in LocationForm for locations.slug. Worth pulling out
// because slug consistency matters across the codebase — every
// place that derives a slug from human-typed text should produce
// the same answer.

/**
 * Convert a human display name into a URL-safe slug.
 *
 *   "UN1T Group"        -> "un1t-group"
 *   "CCF Autos!"        -> "ccf-autos"
 *   "  Hello   World "  -> "hello-world"
 *   "tëst"              -> "tst"  (no transliteration; just strip non-ASCII)
 *
 * @param {string} input
 * @returns {string} the slug. Empty string if input has no usable chars.
 */
export function toSlug(input) {
  if (typeof input !== 'string') return ''
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
