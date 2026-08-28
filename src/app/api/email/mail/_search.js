// MAIL-SEARCH.2/.6 — text query → candidate conversation ids, from TWO legs:
//
//   1. FTS over email_inbox_messages.search_tsv — "which conversations CONTAIN
//      this text" (migs 576/577).
//   2. Escaped ILIKE over email_tickets.requester_name / requester_email —
//      "which conversations are FROM someone whose name or address contains
//      this text".
//
// The sender leg exists because names are STRUCTURED data the tsvector never
// covered: requester_name is not in the generation expression at all, and when
// this was measured against production, 12 of the 27 named conversations had a
// requester whose first name appeared in NO indexed field — those people were
// simply unfindable. It also closes the stopword hole precisely: 'Will' and
// 'Don' are English stopwords, so websearch_to_tsquery discards them into an
// EMPTY query and the FTS leg reports a confident zero — while a no-stopword
// index config (the rejected alternative) would have both broken multi-word
// searches (kept stopwords are ANDed: "freeze my membership" would demand the
// literal word "my") and drowned the person in prose ("I will attend").
// Matching the person on the fields where a person lives fixes the harmful
// case without touching either trade-off.
//
// 🔴 THIS MODULE APPLIES NO VISIBILITY SCOPING, AND MUST NOT LEARN ANY.
// Both legs answer "…at this location", nothing more. The list route filters
// every id returned here through the SAME query it runs for an unsearched
// page — location, visible mailboxes, surface='inbox', unmerged — so there is
// one authority on who may see what. A second scoping implementation in here
// is precisely how a search box becomes an IDOR: the two copies drift, and the
// one nobody is looking at is the one that widens.
//
// The `location_id` filters below are a PERFORMANCE bound, not a security one.
// Deleting them would not leak anything (the route still filters), but it
// would scan every studio's mail to answer one studio's search.

import { escapeLikePattern } from '@/lib/like-escape'

/**
 * How many message rows one search may scan. Every PostgREST select caps at
 * 1,000 regardless of what is asked for, so this is stated rather than
 * discovered — and when the cap is HIT the caller is told, because a truncated
 * search reported as complete is a conversation the operator is told does not
 * exist.
 */
export const SEARCH_SCAN_LIMIT = 1000

/**
 * How many conversation ids one search may hand back to the caller.
 *
 * 🔴 A URL BOUND, NOT A RELEVANCE ONE. The caller intersects these with
 * `.in('id', ids)`, which postgrest-js serialises into the GET query string as
 * `id=in.(<uuid>,<uuid>,…)` — roughly 39 bytes per id once escaped. A thousand
 * of them is a ~39 KB URL, and the proxies, CDNs and servers in front of this
 * app do not agree on how much of that they will carry; the ones that refuse
 * do it with a 414 or a truncated query, neither of which reads as "your
 * search was too broad".
 *
 * 300 ids is ~12 KB, comfortably inside every limit in that chain, and far more
 * conversations than a page shows. Slicing here rather than at the call site
 * keeps `partial` honest — and SENDER matches are placed ahead of FTS matches
 * before the slice, so the person an operator searched for is never the id
 * that gets dropped to make room for the 300th body-text hit.
 */
export const MAX_TICKET_IDS = 300

/**
 * How many conversations one SENDER leg may return. email_tickets holds one
 * row per conversation (30 in production today), so this is headroom, not a
 * working bound — stated because every PostgREST select silently caps at 1,000
 * and an unstated bound is one nobody re-examines when the table grows.
 */
export const SENDER_MATCH_LIMIT = 200

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
 * The conversations whose REQUESTER matches the query — by name or by address.
 *
 * Two SEPARATE `.ilike` queries, never one `.or()`: `.or()` takes a raw
 * PostgREST filter string, and operator-typed text inside one can rewrite the
 * filter (a stray `)` is enough — CLAUDE.md documents the incident). The
 * operator text is escaped with escapeLikePattern and the deliberate substring
 * wildcards are spelled HERE in the source, per the house `.ilike` rule:
 * without the escape, `_` and `%` in the typed text are LIKE wildcards, so
 * searching `a_b` would also match `axb`.
 *
 * Double quotes are stripped first: they are websearch phrase syntax on the
 * FTS leg and never part of a real name or address, so a quoted name should
 * still match the requester fields.
 */
async function senderTicketIds(db, { locationId, query }) {
  const term = query.replace(/"/g, '').trim()
  if (term.length < 2) return { ok: true, ids: [] }

  const ids = new Set()

  for (const column of ['requester_name', 'requester_email']) {
    const { data, error } = await db.from('email_tickets')
      .select('id')
      .eq('location_id', locationId)
      // Wildcards spelled HERE, escaped term inside — the exact shape the
      // no-unescaped-ilike-pattern guardrail requires, so a deliberate
      // substring search is visibly distinct from a forgotten escape.
      .ilike(column, `%${escapeLikePattern(term)}%`)
      // Newest activity first, so if the bound ever bites, what survives is
      // the person's RECENT conversations — same reasoning as the FTS scan.
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(SENDER_MATCH_LIMIT)

    if (error) {
      // A failed sender leg must never quietly become "that person has no
      // mail" — the confident-zero lie again, this time about the exact case
      // this leg exists to fix. Logged here because the route's handler
      // returns a generic 500 with no log of its own.
      console.error(`[email/mail] sender search (${column}) failed:`, error.message)
      return { ok: false, error: error.message }
    }
    for (const row of data || []) {
      if (row?.id) ids.add(row.id)
    }
  }

  return { ok: true, ids: Array.from(ids) }
}

/**
 * Which conversations at this location match `q` — by content OR by sender?
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
    // config MUST match mig 576/577's generation expression — see those
    // migrations for why a bare (unconfigured) call would silently drift.
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
    // '[email/mail] message count scan failed:'). The route handler returns a
    // generic 500 with no log of its own, so if this call site doesn't log it,
    // a search failing in production leaves no trace at all.
    console.error('[email/mail] search scan failed:', error.message)
    // A failed query is not an empty result — the two must never collapse into
    // one another. "boom" reaching the operator as a calm empty inbox is the
    // same defect class as reporting an unreadable mailbox as having no mail.
    return { ok: false, error: error.message }
  }

  const sender = await senderTicketIds(db, { locationId, query })
  if (!sender.ok) {
    // Both legs are halves of ONE answer. Returning the FTS half while the
    // sender half silently failed would tell an operator that the person they
    // searched for has no mail — the precise lie the sender leg exists to end.
    // Search is stateless and retryable, so failing loudly costs one retry.
    return { ok: false, error: sender.error }
  }

  const rows = data || []
  const ftsIds = rows.map(r => r.ticket_id).filter(Boolean)

  // 🔴 THE STOPWORD GAP, NARROWED BUT NOT GONE — the honest state of play:
  //   · a PERSON named Will/Don is now found, by the sender leg, because the
  //     name lives in requester_name/requester_email and matching those fields
  //     structurally does not care what English considers a stopword.
  //   · a PROSE search whose every term is a stopword ('off', 'no', 'the will
  //     be') still never really runs on the FTS leg — verified live:
  //     websearch_to_tsquery('english', …) returns an EMPTY tsquery for those,
  //     which matches nothing, byte-identically to a genuine miss. Only the
  //     sender leg can answer such a query now, and the surface still echoes
  //     the typed query back in its empty state so a zero is legible.
  // There is no cheap PostgREST-side detection of the empty-tsquery case; an
  // RPC could tell, and building one is a separate, reviewed decision.
  //
  // SENDER IDS FIRST, then FTS ids, deduped, then the URL cap. The order is
  // load-bearing: under the cap, the person an operator searched for must
  // never be the id dropped to make room for the 300th body-text match.
  const union = Array.from(new Set([...sender.ids, ...ftsIds]))
  const capped = union.slice(0, MAX_TICKET_IDS)
  // Two independent reasons the answer can be incomplete, and the caller only
  // needs to know THAT it is: the message scan hit its row cap, or more
  // conversations matched than one URL can carry.
  const partial = rows.length >= SEARCH_SCAN_LIMIT || union.length > MAX_TICKET_IDS
  return { ok: true, skipped: false, ids: capped, partial }
}
