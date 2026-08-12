// EMAIL-MERGE.1 — pure rules for folding one ticket into another.
//
// The problem: two tickets that are really one conversation. An operator
// answered both, and the correspondent got the same reply twice. Merge joins
// them; mig 536 makes it reversible (email_tickets.merged_into_id, and
// email_inbox_messages.merged_from_ticket_id stamped on every row that moves,
// so unmerge restores exactly those and nothing else).
//
// Pure (no DB, no clock, no env) so the refusals can be tested exhaustively
// rather than inferred from a route's control flow — the same argument
// email-recipients.js is built on.
//
// NOTE ON STATUS: a merged ticket stays in the `open|pending|solved|closed`
// vocabulary — it is CLOSED plus a pointer. A fifth enum value would have to be
// audited through every view filter, the count endpoint, the mobile status
// picker and the needs-reply badge, and this estate has been bitten by exactly
// that. Nothing here invents one.

/**
 * May `source` be folded into `target`?
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canMerge(source, target) {
  if (!source?.id || !target?.id) return { ok: false, reason: 'missing_ticket' }
  if (source.id === target.id) return { ok: false, reason: 'same_ticket' }
  // Location scoping is the whole tenancy model here; a cross-studio merge
  // would move one studio's correspondence into another's inbox.
  if (source.location_id !== target.location_id) return { ok: false, reason: 'different_location' }
  // Chains are refused so unmerge stays exact: with A→B→C, unmerging B could
  // not tell A's rows from B's own.
  if (source.merged_into_id) return { ok: false, reason: 'source_already_merged' }
  if (target.merged_into_id) return { ok: false, reason: 'target_is_merged' }
  return { ok: true }
}

/**
 * The target's fields after absorbing the source.
 *
 * first_response_at takes the EARLIER of the two: it measures how long the
 * person waited for a human, and merging two records of one conversation does
 * not make that wait longer.
 */
export function mergedTicketFields(source, target) {
  const at = (v) => (v ? Date.parse(v) : NaN)
  const earlier = (a, b) => {
    if (!a) return b || null
    if (!b) return a
    return at(a) <= at(b) ? a : b
  }
  const sourceIsNewer = (at(source?.last_message_at) || 0) > (at(target?.last_message_at) || 0)
  const newest = sourceIsNewer ? source : target

  return {
    unread_count: (source?.unread_count || 0) + (target?.unread_count || 0),
    first_response_at: earlier(source?.first_response_at, target?.first_response_at),
    last_message_at: newest?.last_message_at ?? null,
    last_message_direction: newest?.last_message_direction ?? null,
    last_message_preview: newest?.last_message_preview ?? null,
  }
}
