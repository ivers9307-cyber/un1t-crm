// EMAIL-ATTACH.1 — GET /api/email/tickets/[id]/attachments/[attachmentId]
//
// Mints a short-lived signed URL for ONE stored attachment. The
// `email-attachments` bucket is private, so this route is the only way a
// browser ever sees the bytes, and the URL expires.
//
// ACCESS IS THE TICKET'S ACCESS, DELIBERATELY REUSED.
// loadTicketForUser() is the two-level gate the rest of the ticket surface runs
// on: the caller must reach the ticket's LOCATION and must be able to see the
// MAILBOX it arrived at (or be elevated, for a ticket whose mailbox is gone).
// Re-deriving that here would be a second definition of who may read
// `accounts@`, and the two would drift. This route adds exactly one check on
// top: the attachment must belong to THIS ticket.
//
// THAT ONE EXTRA CHECK IS THE WHOLE IDOR. Without it a coach with a grant on
// `sales@` could pass any ticket they can open as `[id]` and any attachment id
// in the estate as `[attachmentId]`, and be handed a signed URL for the billing
// correspondence the per-mailbox model exists to keep from them. The attachment
// is resolved by id, then its message is resolved and its ticket_id compared to
// the ticket the caller proved access to.
//
// 404, NEVER 403, for every refusal — no such attachment, an attachment on
// another ticket, and an attachment whose bytes were never stored are all the
// same answer from outside, so ids cannot be probed.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { signedAttachmentUrl } from '@/lib/email-attachments-server'
import { SKIPPED_REASON_LABEL } from '@/lib/email-attachment-quota'
import { loadTicketForUser, ticketNotFound } from '../../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Long enough to click and download a large file on a bad connection, short
// enough that a URL copied out of a network tab is worthless by the time
// anyone reads it.
const SIGNED_URL_TTL_SECONDS = 300

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json(
      { success: false, error: 'Forbidden — email inbox permission required' },
      { status: 403 }
    )
  }

  const db = createServerClient()

  // The gate. Everything below inherits the location + mailbox scoping it
  // applied; nothing here re-derives access.
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const { data: attachment, error } = await db.from('email_ticket_attachments')
    .select('id, message_id, location_id, filename, mime_type, size_bytes, storage_path, skipped_reason')
    .eq('id', params.attachmentId)
    .maybeSingle()
  // A malformed id is a Postgres cast error (22P02), not a row — same 404.
  if (error || !attachment) return ticketNotFound()

  // Belt: the attachment's own location must match the ticket's. Braces: the
  // message it hangs off must belong to THIS ticket. The second is the real
  // check — the first would pass for every ticket at the same studio.
  if (attachment.location_id !== ticket.location_id) return ticketNotFound()

  const { data: message, error: msgErr } = await db.from('email_inbox_messages')
    .select('id, ticket_id')
    .eq('id', attachment.message_id)
    .maybeSingle()
  if (msgErr || !message || message.ticket_id !== ticket.id) return ticketNotFound()

  if (!attachment.storage_path) {
    // Not an error state — mig 482's XOR guarantees a reason, and staff are
    // entitled to know which one so they can ask for a resend. Still a 404:
    // there is nothing to serve, and the caller already holds the ticket, so
    // naming the reason discloses nothing they cannot already read.
    return NextResponse.json({
      success: false,
      error: SKIPPED_REASON_LABEL[attachment.skipped_reason] || 'Not stored',
      data: { skipped_reason: attachment.skipped_reason },
    }, { status: 404 })
  }

  const url = await signedAttachmentUrl(db, attachment.storage_path, {
    filename: attachment.filename,
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
  })
  if (!url) {
    // The row says stored but Storage would not sign it — a real fault worth a
    // 500 rather than a 404, because "the file is missing from the bucket" and
    // "you may not have this file" are different problems for an operator.
    return NextResponse.json(
      { success: false, error: 'Could not prepare that file for download.' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    data: {
      url,
      // storage_path is NEVER returned: it is internal addressing, and the
      // signed URL is the only handle a client needs.
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      expires_in: SIGNED_URL_TTL_SECONDS,
    },
  })
}
