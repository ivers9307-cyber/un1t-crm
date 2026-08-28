// MAIL-SEARCH.1 — text query → candidate conversation ids.
//
// 🔴 THIS MODULE APPLIES NO VISIBILITY SCOPING, AND MUST NOT LEARN ANY.
// It answers exactly one question: which conversations at this location contain
// this text? The list route then filters those ids through the SAME query it
// runs for an unsearched page — location, visible mailboxes, surface='inbox',
// unmerged — so there is one authority on who may see what. A second scoping
// implementation in here is precisely how a search box becomes an IDOR: the two
// copies drift, and the one nobody is looking at is the one that widens.
//
// The `location_id` filter below is a PERFORMANCE bound, not a security one.
// Deleting it would not leak anything (the route still filters), but it would
// scan every studio's mail to answer one studio's search.

/**
 * How many message rows one search may scan. Every PostgREST select caps at
 * 1,000 regardless of what is asked for, so this is stated rather than
 * discovered — and when the cap is HIT the caller is told, because a truncated
 * search reported as complete is a conversation the operator is told does not
 * exist.
 */
export const SEARCH_SCAN_LIMIT = 1000

/**
 * The query an operator actually typed, or null when there is nothing worth
 * running. A single character matches most of the corpus and costs a full scan
 * to say so.
 */
export function normalizeQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return q.length >= 2 ? q : null
}

/**
 * Which conversations at this location contain `q`?
 *
 * @returns {Promise<
 *   {ok: true, skipped: true, ids: [], partial: false} |
 *   {ok: true, skipped: false, ids: string[], partial: boolean} |
 *   {ok: false, error: string}
 * >}
 */
export async function searchTicketIds(db, { locationId, q }) {
  const query = normalizeQuery(q)
  if (!query || !locationId) {
    return { ok: true, skipped: true, ids: [], partial: false }
  }

  const { data, error } = await db.from('email_inbox_messages')
    .select('ticket_id')
    .eq('location_id', locationId)
    // A message with no conversation cannot be shown in a conversation list.
    .not('ticket_id', 'is', null)
    // `websearch` is the syntax a person already knows from every search box:
    // quoted phrases, OR, and a leading minus to exclude. `plain` would treat a
    // quoted phrase as loose words and quietly return the wrong thing. The
    // config MUST match mig 576's generation expression — see that migration
    // for why a bare (unconfigured) call would silently drift.
    .textSearch('search_tsv', query, { type: 'websearch', config: 'english' })
    .limit(SEARCH_SCAN_LIMIT)

  // A failed query is not an empty result — the two must never collapse into
  // one another. "boom" reaching the operator as a calm empty inbox is the
  // same defect class as reporting an unreadable mailbox as having no mail.
  if (error) return { ok: false, error: error.message }

  const rows = data || []
  const ids = Array.from(new Set(rows.map(r => r.ticket_id).filter(Boolean)))
  // Rows are NOT ordered here (there is no ticket_id ORDER BY), so hitting the
  // cap means an unknown, unordered subset of matches came back — not a clean
  // suffix like loadConversationCounts' scan. `partial` says only "there may be
  // more"; the caller must not assume anything about which ids were dropped.
  return { ok: true, skipped: false, ids, partial: rows.length >= SEARCH_SCAN_LIMIT }
}
