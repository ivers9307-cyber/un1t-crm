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

// email-inbox.js is pure too (its own header says so), so importing the preview
// rule keeps this file's no-DB/no-clock promise while leaving ONE definition of
// what a queue preview looks like.
import { inboundPreview } from './email-inbox'

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
 * EMAIL-MERGE.4 — a ticket's denormalised fields DERIVED from its messages, so
 * unmerge can put both tickets back the way it found them.
 *
 * mergedTicketFields() overwrites the survivor's last-message trio with the
 * newer of the two. Undoing that needs the survivor's own former values, and
 * nothing stores them — so they are re-derived from the rows that are actually
 * on the ticket once the moved ones have gone. Left alone, the survivor would
 * keep advertising a message that now lives on another ticket: wrong preview in
 * the queue, and a sort key it does not own.
 *
 * THE RULES MIRROR THE WRITERS, because a derivation that disagrees with them
 * would rewrite correct rows every time an unmerge ran:
 *   • NOTES AND FORWARDS ARE SKIPPED. The reply route returns before touching
 *     email_tickets for an internal note, and the forward route never updates
 *     the ticket at all — so neither has ever advanced a trio, and neither may
 *     start now.
 *   • created_at IS THE CLOCK, NOT sent_at. sent_at on an inbound row is the
 *     SENDER'S Date header (postmark-inbound: `parseEmailDate(body.Date)`) —
 *     remote, unvalidated, and free to be years off. last_message_at means when
 *     it reached us, which is created_at, and that is what the webhook and the
 *     reply route both write.
 *   • first_response_at is the FIRST non-note outbound, matching
 *     shouldStampFirstResponse(): outbound, not a note, first one only.
 *   • The preview uses inboundPreview() with the same subject fallback the
 *     webhook uses, so a derived preview is byte-identical to the stored one.
 *
 * @param {object[]} messages  every message on the ticket (any order)
 */
export function ticketFieldsFromMessages(messages) {
  const real = (messages || []).filter(m => m && !m.is_internal_note && !m.forwarded_message_id)
  const inOrder = [...real].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  const newest = inOrder[inOrder.length - 1] || null
  const firstOutbound = inOrder.find(m => m.direction === 'outbound') || null

  return {
    first_response_at: firstOutbound?.created_at ?? null,
    last_message_at: newest?.created_at ?? null,
    last_message_direction: newest?.direction ?? null,
    last_message_preview: newest
      ? (inboundPreview(newest.text_body) || inboundPreview(newest.subject) || '')
      : null,
  }
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
    // MAIL-SENT.1 — a survivor that absorbed ANY received mail has received
    // mail: OR, never newest-wins (merging an inbound thread into an
    // outbound-only one must move the survivor to Inbox).
    has_inbound: Boolean(source?.has_inbound || target?.has_inbound),
  }
}
