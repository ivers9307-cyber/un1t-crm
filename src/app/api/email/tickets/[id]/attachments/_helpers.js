// EMAIL-ATTACH-PREVIEW.1 — the gate shared by the two attachment routes.
//
// There are now two ways to reach an attachment's bytes: a DOWNLOAD URL
// (…/attachments/[attachmentId]) and an INLINE PREVIEW URL
// (…/attachments/[attachmentId]/preview). They differ in exactly one thing —
// whether Storage is asked for `Content-Disposition: attachment` — and they
// must be identical in who is allowed to reach them. Two copies of that
// resolution would be two definitions of who may read `accounts@`, and the two
// would drift; the first copy to be forgotten is the leak.
//
// ══ THE GATE, IN ORDER ══════════════════════════════════════════════
//
// 1. loadTicketForUser() — the two-level check the whole ticket surface runs
//    on: the caller must reach the ticket's LOCATION, must hold `email_inbox`
//    THERE, and must be able to see the MAILBOX it arrived at (or be elevated,
//    for a ticket whose mailbox is gone). Nothing here re-derives any of it.
//
// 2. THE PAIRING CHECK, WHICH IS THE WHOLE IDOR. The attachment must belong to
//    THIS ticket. Without it a coach with a grant on `sales@` could pass any
//    ticket they can open as `[id]` together with any attachment id in the
//    estate as `[attachmentId]`, and be handed the billing correspondence the
//    per-mailbox model exists to keep from them. Both halves of that request
//    are individually legitimate; only this check refuses it.
//
// 404, NEVER 403, for every refusal — no such attachment, an attachment on
// another ticket, and (for the caller) an attachment whose bytes were never
// stored are all the same answer from outside, so ids cannot be probed.
//
// storage_path is selected here because signing needs it. It MUST NOT be put in
// a response by either caller: it is internal addressing, and a signed URL is
// the only handle a client needs.

import { NextResponse } from 'next/server'
import { SKIPPED_REASON_LABEL } from '@/lib/email-attachment-quota'
import { loadTicketForUser, ticketNotFound } from '../../_helpers'

const ATTACHMENT_COLUMNS =
  'id, message_id, location_id, filename, mime_type, size_bytes, storage_path, skipped_reason'

/**
 * Resolve one attachment for one caller, or the response that refuses them.
 *
 * @param {object} db  service-role client
 * @param {object} user  getCurrentUser() result
 * @param {string} ticketId
 * @param {string} attachmentId
 * @returns {Promise<{ response: NextResponse } | { ticket: object, attachment: object }>}
 *   A resolved `attachment` is guaranteed to have a non-null storage_path — the
 *   never-stored case is answered here, with its reason, so neither caller has
 *   to remember to check.
 */
export async function loadAttachmentForTicket(db, user, ticketId, attachmentId) {
  // The gate. Everything below inherits the location + mailbox scoping it
  // applied.
  const loaded = await loadTicketForUser(db, user, ticketId)
  if (loaded.response) return { response: loaded.response }
  const { ticket } = loaded

  const { data: attachment, error } = await db.from('email_ticket_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('id', attachmentId)
    .maybeSingle()
  // A malformed id is a Postgres cast error (22P02), not a row — same 404.
  if (error || !attachment) return { response: ticketNotFound() }

  // Belt: the attachment's own location must match the ticket's. Braces: the
  // message it hangs off must belong to THIS ticket. The second is the real
  // check — the first would pass for every ticket at the same studio.
  if (attachment.location_id !== ticket.location_id) return { response: ticketNotFound() }

  const { data: message, error: msgErr } = await db.from('email_inbox_messages')
    .select('id, ticket_id')
    .eq('id', attachment.message_id)
    .maybeSingle()
  if (msgErr || !message || message.ticket_id !== ticket.id) return { response: ticketNotFound() }

  if (!attachment.storage_path) {
    // Not an error state — mig 482's XOR guarantees a reason, and staff are
    // entitled to know which one so they can ask for a resend. Still a 404:
    // there is nothing to serve, and the caller already holds the ticket, so
    // naming the reason discloses nothing they cannot already read.
    return {
      response: NextResponse.json({
        success: false,
        error: SKIPPED_REASON_LABEL[attachment.skipped_reason] || 'Not stored',
        data: { skipped_reason: attachment.skipped_reason },
      }, { status: 404 }),
    }
  }

  return { ticket, attachment }
}
