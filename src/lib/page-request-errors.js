// PAGES.1 — a public route's page-form refusal carries a machine word in
// `error` ('not_found' for a page or studio that is not there,
// 'studio_required' for an all-studios page asked with no studio). A customer
// never reads one: the funnel shows its own fallback instead. Pure, client-safe.

const MACHINE_WORDS = new Set(['not_found', 'studio_required'])

/** The server's words when they are words, else `fallback`. */
export function customerErrorText(error, fallback) {
  return typeof error === 'string' && error.trim() && !MACHINE_WORDS.has(error) ? error : fallback
}
