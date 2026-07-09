// GLOFOX-NOTES — pure helpers for the outbound note push + echo reconciliation.
// No DB, no network — string building + fingerprint matching only.

const MAX_DESCRIPTION = 500
const ECHO_WINDOW_MS = 2 * 60 * 60 * 1000 // 2h — exact-text match makes this safe

/**
 * Build the Glofox interaction description from a CRM note: author-prefixed
 * (Glofox interactions carry no author field) and truncated to 500 chars with
 * an ellipsis. Returns { description, truncated }.
 */
export function buildInteractionDescription({ authorName, content } = {}) {
  const prefix = authorName && authorName.trim()
    ? `[UN1T CRM · ${authorName.trim()}] `
    : '[UN1T CRM] '
  const full = prefix + (content || '')
  if (full.length <= MAX_DESCRIPTION) return { description: full, truncated: false }
  // Reserve 1 char for the ellipsis marker.
  return { description: full.slice(0, MAX_DESCRIPTION - 1) + '…', truncated: true }
}

/**
 * Is this incoming Glofox interaction the echo of a ledger push? Exact
 * description + type match, same contact, within the echo window of pushed_at.
 * interaction.created is Unix SECONDS (Glofox convention).
 */
export function matchesPush(interaction, pushRow, contactId) {
  if (!interaction || !pushRow) return false
  if (pushRow.contact_id !== contactId) return false
  if (String(interaction.type || '') !== pushRow.type) return false
  if (String(interaction.description || '') !== pushRow.description) return false
  const createdMs = Number(interaction.created) * 1000
  const pushedMs = new Date(pushRow.pushed_at).getTime()
  if (!Number.isFinite(createdMs) || !Number.isFinite(pushedMs)) return false
  return Math.abs(createdMs - pushedMs) <= ECHO_WINDOW_MS
}
