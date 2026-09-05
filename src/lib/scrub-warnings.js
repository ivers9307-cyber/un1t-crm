// MAIL-GDPR.1 (review fix 3) — shape a delete route's `scrub_warnings` for the
// operator. Pure and client-safe: both delete dialogs import it, so it must
// pull in none of the server-side erasure module.
//
// A failure is a STATEMENT that failed (an UPDATE on email_tickets, a storage
// remove), not a row count, so the copy says "steps", never "rows".

/**
 * @param {Array<{ table?: string, op?: string, message?: string }>|undefined} failures
 * @returns {null | { count: number, tables: string[], text: string }} null when there is nothing to say.
 */
export function summariseScrubWarnings(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null
  const tables = [...new Set(failures.map(f => f?.table).filter(Boolean))]
  const count = failures.length
  const text = `${count} mail scrub step${count === 1 ? '' : 's'} failed (${tables.join(', ')})`
  return { count, tables, text }
}

/**
 * The bulk route's per-contact warnings, shaped as the modal's Section rows.
 * @param {Array<{ id: string, name?: string|null, failures: Array }>|undefined} warnings
 * @returns {Array<{ id: string, name: string, reason: string }>}
 */
export function scrubIncompleteRows(warnings) {
  if (!Array.isArray(warnings)) return []
  const rows = []
  for (const w of warnings) {
    const summary = summariseScrubWarnings(w?.failures)
    if (!summary) continue
    rows.push({ id: w.id, name: w.name || w.id, reason: summary.text })
  }
  return rows
}
