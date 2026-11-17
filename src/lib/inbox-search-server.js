// INBOX-SEARCH.1 — server-side unified-inbox search helpers.
//
// Why this exists: each channel list route returns only the latest 50
// conversations, and the inbox's "Search people & messages" box filtered
// those client-side — so with ~1,178 prod WhatsApp threads, ~96% were
// unreachable from search. The conversation list routes now accept
// ?q= (2+ chars) and OR together:
//   (a) conversations linked to contacts whose name / phone / email
//       matches — found via a scoped id-lookup first, because PostgREST
//       can't reliably filter on embedded resources (CLAUDE.md invariant);
//   (b) conversations whose OWN denormalised fields match (covers
//       threads with no linked contact at all).
//
// WAMSGSEARCH.1 (2026-11-16) — (c) WhatsApp threads whose message TEXT
// matches, found by searchWhatsAppMessageHits below (3+ characters, studios
// where the caller holds WhatsApp only, a literal substring). Before it the
// box said "people & messages" and matched only the 100-character preview.
// Instagram message text is not searched: it lives in another table with no
// helper here, and the inbox's Instagram volume is small.
//
// The pure string-building lives here so it's testable without a DB;
// searchInboxContactIds is the one IO helper the routes share.

import { escapeLikePattern } from './like-escape'

// Real columns per table (verified against live information_schema,
// 2026-07-25). Keep in sync with what the queue rows actually display.
//
// INBOX-SPLIT.1 (2026-08-07) — `email_conversations` dropped: the inbox is
// WhatsApp + Instagram only, so there is no email fan-out left to build an
// OR-filter for. Email search belongs to /communications/mail, which has
// its own query path over `email_tickets`. `buildInboxSearchOr` throws on an
// unknown table by design, so re-adding a caller here has to be deliberate.
export const INBOX_SEARCH_FIELDS = Object.freeze({
  whatsapp_conversations: Object.freeze(['wa_phone', 'wa_profile_name', 'last_message_preview']),
  instagram_conversations: Object.freeze(['ig_username', 'customer_name', 'last_message_preview']),
})

// Minimum query length before the server search kicks in — mirrors the
// xero contacts picker. Shorter queries fall back to the plain list.
export const INBOX_SEARCH_MIN_LENGTH = 2

/**
 * Make a user-typed term safe inside a PostgREST `.or()` ilike pattern.
 * `%` and `_` are ilike wildcards → backslash-escaped. `,` `(` `)` are
 * STRUCTURAL in the or-syntax and can't be reliably escaped → stripped
 * (nobody greps their inbox for parentheses; a broken or-string would
 * 400 the whole request).
 *
 * @param {string} q
 * @returns {string}
 */
export function escapeIlikeTerm(q) {
  return String(q || '')
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, (c) => `\\${c}`)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build the `.or()` filter string for a conversation table: matched
 * contact ids OR the table's own searchable fields.
 *
 * @param {keyof typeof INBOX_SEARCH_FIELDS} table
 * @param {string} q            raw user query
 * @param {string[]} contactIds ids from searchInboxContactIds (may be empty)
 * @returns {string}
 */
export function buildInboxSearchOr(table, q, contactIds, conversationIds = []) {
  const fields = INBOX_SEARCH_FIELDS[table]
  if (!fields) throw new Error(`buildInboxSearchOr: unknown table '${table}'`)
  const term = escapeIlikeTerm(q)
  const clauses = []
  if (contactIds?.length) clauses.push(`contact_id.in.(${contactIds.join(',')})`)
  // WAMSGSEARCH.1 — threads whose message TEXT matched (searchWhatsAppMessageHits).
  if (conversationIds?.length) clauses.push(`id.in.(${conversationIds.join(',')})`)
  for (const f of fields) clauses.push(`${f}.ilike.%${term}%`)
  return clauses.join(',')
}

/**
 * Find contact ids matching the query within the caller's location
 * scope — step (a) of the search. Capped: 100 ids is plenty to seed the
 * conversation OR-filter, and keeps the in-list bounded.
 *
 * Best-effort: a lookup failure returns [] so the conversation-field
 * match still runs (search degrades, doesn't 500).
 *
 * @param {object} db           service-role client
 * @param {object} args
 * @param {string} args.q
 * @param {string[]} args.locationIds  scope — same set the list query uses
 * @returns {Promise<string[]>}
 */
export async function searchInboxContactIds(db, { q, locationIds }) {
  if (!locationIds?.length) return []
  const term = escapeIlikeTerm(q)
  if (!term) return []
  try {
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .in('location_id', locationIds)
      .or(`name.ilike.%${term}%,first_name.ilike.%${term}%,phone.ilike.%${term}%,wa_phone.ilike.%${term}%,email.ilike.%${term}%`)
      .limit(100)
    if (error) return []
    return (data || []).map((r) => r.id)
  } catch {
    return []
  }
}

// ─── WAMSGSEARCH.1 — WhatsApp message text ────────────────────────────────

/** Below this many characters message text is not searched (every short word matches thousands of rows). */
export const INBOX_MESSAGE_SEARCH_MIN_LENGTH = 3
/** At most this many conversations come back from a message-text search. */
export const INBOX_MESSAGE_SEARCH_CONVERSATION_CAP = 50
// Matching messages read, newest first, to find those conversations. A busy
// thread can hold many hits, so this is a multiple of the cap (and under
// PostgREST's 1,000-row ceiling, so one page is the whole answer).
export const INBOX_MESSAGE_SEARCH_ROW_CAP = 500
const SNIPPET_RADIUS = 40

/**
 * A short piece of `body` around the first case-insensitive match of `term`,
 * with an ellipsis where it was cut. The whole body (trimmed to twice the
 * radius) when the match is not found, e.g. it spans a line break the
 * database matched on.
 *
 * @param {string} body
 * @param {string} term
 * @returns {string}
 */
export function messageSnippet(body, term, radius = SNIPPET_RADIUS) {
  const text = String(body || '').replace(/\s+/g, ' ').trim()
  const needle = String(term || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2).trimEnd()}…` : text
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/**
 * Collapse matching message rows (newest first) into one hit per
 * conversation: its newest match and a snippet of it, in order of that
 * match, at most `cap`.
 *
 * @param {Array<{ conversation_id: string, body: string, created_at: string }>} rows
 * @param {string} term
 */
export function collapseMessageHits(rows, term, cap = INBOX_MESSAGE_SEARCH_CONVERSATION_CAP) {
  const hits = []
  const seen = new Set()
  for (const row of rows || []) {
    if (!row?.conversation_id || seen.has(row.conversation_id)) continue
    seen.add(row.conversation_id)
    hits.push({ conversation_id: row.conversation_id, snippet: messageSnippet(row.body, term), matched_at: row.created_at || null })
    if (hits.length >= cap) break
  }
  return hits
}

/**
 * WhatsApp conversations whose message TEXT contains `q`, at the given
 * studios only. The caller passes the studios where the person holds
 * WhatsApp (web or mobile): message bodies are the inbox's content, so the
 * scope is the permission's, not mere membership.
 *
 * A literal, case-insensitive substring: `%`, `_` and `\` in the query are
 * escaped (escapeLikePattern) and the wildcards are ours. Best-effort like
 * the contact lookup: a failed read answers { hits: [], failed: true } and
 * the rest of the search still runs.
 *
 * @param {object} db  service-role client
 * @param {{ q: string, locationIds: string[] }} args
 * @returns {Promise<{ hits: Array<{ conversation_id: string, snippet: string, matched_at: string|null }>, failed: boolean }>}
 */
export async function searchWhatsAppMessageHits(db, { q, locationIds }) {
  const term = String(q || '').trim()
  if (term.length < INBOX_MESSAGE_SEARCH_MIN_LENGTH || !locationIds?.length) return { hits: [], failed: false }
  try {
    const { data, error } = await db
      .from('whatsapp_messages')
      .select('conversation_id, body, created_at')
      .in('location_id', locationIds)
      .not('conversation_id', 'is', null)
      .ilike('body', `%${escapeLikePattern(term)}%`)
      .order('created_at', { ascending: false })
      .limit(INBOX_MESSAGE_SEARCH_ROW_CAP)
    if (error) return { hits: [], failed: true }
    return { hits: collapseMessageHits(data, term), failed: false }
  } catch {
    return { hits: [], failed: true }
  }
}
