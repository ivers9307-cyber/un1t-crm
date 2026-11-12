// offers-legacy-redirect.js — BLACKFRIDAY.3. Before the per-studio pages,
// every offer lived at /offers/<slug> and was Stillorgan's. Those links are
// in sent emails and Revolut's redirect URLs (?purchase=<id>), so a legacy
// slug now redirects to its Stillorgan page, keeping the purchase to resume.

/** Pure. The Stillorgan product page for a legacy /offers/<slug> link. */
export function legacyOfferRedirect(slug, purchase) {
  const path = `/offers/stillorgan/${encodeURIComponent(slug)}`
  return purchase ? `${path}?purchase=${encodeURIComponent(purchase)}` : path
}
