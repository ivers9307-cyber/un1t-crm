// MAIL-SEARCH.2 — text query → candidate conversation ids.
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
 * running.
 *
 * The 2-character floor is a typing-debounce, not a performance guard — it is
 * NOT "one character forces a full scan". It doesn't: a single non-stopword
 * lexeme (`x`, `5`) is answered by an ordinary GIN index lookup, the same as
 * any longer term. The floor exists because one character is rarely a useful
 * thing to type-ahead against, and two is the shortest query worth the round
 * trip.
 *
 * Worth knowing even though this function does nothing about it: `-x` is two
 * characters, clears this floor, and `websearch_to_tsquery` turns a leading
 * minus into negation (`!'x'` — "every document NOT containing x"). THAT
 * genuinely cannot be answered by an index lookup and forces a much larger
 * scan than an ordinary term. Nothing here guards against it; SEARCH_SCAN_LIMIT
 * is the only thing bounding it, same as any other broad query.
 */
export function normalizeQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return q.length >= 2 ? q : null
}

/**
 * Which conversations at this location contain `q`?
 *
 * @returns {Promise<
 *   {ok: true, skipped: true, ids: null, partial: false} |
 *   {ok: true, skipped: false, ids: string[], partial: boolean} |
 *   {ok: false, error: string}
 * >}
 */
export async function searchTicketIds(db, { locationId, q }) {
  const query = normalizeQuery(q)
  if (!query || !locationId) {
    // `ids: null`, not `[]`. "No query typed" and "the query ran and matched
    // nothing" must stay visibly different shapes on the wire — a caller that
    // applied `.in('id', ids)` unconditionally on an `[]` here would render an
    // empty inbox on first page load (no query yet); `null` makes that mistake
    // throw immediately instead of silently showing nothing.
    return { ok: true, skipped: true, ids: null, partial: false }
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
    // Newest first, so a scan that HITS the cap below has thrown away the
    // OLDEST matches, not an arbitrary set. With no ORDER BY, a GIN bitmap
    // heap scan over an append-only message table comes back in roughly
    // physical/insertion order — oldest-first — which is exactly backwards for
    // a mail search: recent correspondence is overwhelmingly what an operator
    // is looking for. This is what makes `partial` mean "the most recent
    // 1,000 matches", a stated bound, rather than "an arbitrary 1,000".
    .order('created_at', { ascending: false })
    .limit(SEARCH_SCAN_LIMIT)

  if (error) {
    // Logged at the failure site, matching the sibling scan next door
    // (_helpers.js's loadConversationCounts logs
    // '[email/mail] message count scan failed:'). Task 3's route handler
    // returns a generic 500 with no log of its own, so if this call site
    // doesn't log it, a search failing in production leaves no trace at all.
    console.error('[email/mail] search scan failed:', error.message)
    // A failed query is not an empty result — the two must never collapse into
    // one another. "boom" reaching the operator as a calm empty inbox is the
    // same defect class as reporting an unreadable mailbox as having no mail.
    return { ok: false, error: error.message }
  }

  const rows = data || []
  const ids = Array.from(new Set(rows.map(r => r.ticket_id).filter(Boolean)))

  // 🔴 THREE STATES SHARE THE SHAPE {ok:true, skipped:false, ids:[]}, AND ONLY
  // ONE OF THEM MEANS "THIS PERSON'S MAIL GENUINELY DOESN'T MENTION THAT":
  //   1. the query ran and genuinely matched nothing.
  //   2. the query ran, hit SEARCH_SCAN_LIMIT, and none of the (most recent)
  //      1,000 rows scanned matched — distinguishable via `partial: true`.
  //   3. the query NEVER REALLY RAN. websearch_to_tsquery('english', …)
  //      returns an EMPTY tsquery for input that is entirely English
  //      stopwords or punctuation — verified against the live database for
  //      'Will', 'the', 'or', 'down', 'the will be', '-', '---', '!!!', '@' —
  //      and an empty tsquery matches every row's tsvector zero times. On the
  //      wire this is byte-identical to state 1: a member named Will is
  //      unfindable by first name, and the operator is told, confidently,
  //      that no such mail exists.
  // State 3 is not detected here. There is no cheap PostgREST-side way to ask
  // "did the query produce anything to search for" — only an RPC could, and
  // building one is a separate, reviewed decision, not something to reach for
  // quietly inside this helper. The honest fix for now lives on the SURFACE,
  // not in this module: it echoes the operator's own typed query back in its
  // empty state ("No results for 'Will'"), so someone who knows they searched
  // a common first name can see exactly what was asked for and try a fuller
  // phrase instead of trusting a confident zero.
  return { ok: true, skipped: false, ids, partial: rows.length >= SEARCH_SCAN_LIMIT }
}
