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
// The pure string-building lives here so it's testable without a DB;
// searchInboxContactIds is the one IO helper the routes share.

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
export function buildInboxSearchOr(table, q, contactIds) {
  const fields = INBOX_SEARCH_FIELDS[table]
  if (!fields) throw new Error(`buildInboxSearchOr: unknown table '${table}'`)
  const term = escapeIlikeTerm(q)
  const clauses = []
  if (contactIds?.length) clauses.push(`contact_id.in.(${contactIds.join(',')})`)
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
