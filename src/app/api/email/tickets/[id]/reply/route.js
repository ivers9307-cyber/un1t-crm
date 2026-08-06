import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { sendEmail } from '@/lib/postmark'
import { replySubject, buildReplyHeaders, inboundPreview } from '@/lib/email-inbox'
import { shouldStampFirstResponse } from '@/lib/email-tickets'
import { loadTicketForUser, statusTimestamps } from '../../_helpers'

const ReplySchema = z.object({
  text: z.string().trim().min(1).max(10000),
  // An internal note is staff-to-staff on the ticket. It is written to the
  // thread and NOTHING is sent — the member never sees it, so it also never
  // stamps first_response_at and never advances the ticket.
  internal: z.boolean().optional().default(false),
})

// Minimal text → HTML, same as the conversations send route this replaces: a
// 1:1 human reply is escaped text with line breaks, not designed mail.
function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${escaped}</div>`
}

// POST /api/email/tickets/[id]/reply — answer a ticket, or add an internal
// note (EMAIL-TICKET.4).
//
// Replies ride Postmark's TRANSACTIONAL stream ('outbound'), NOT broadcast,
// and carry NO marketing-consent gate: the member wrote to us first, and a
// suppression flag silently swallowing the answer to their own question is
// worse than the consent risk it avoids (spec, "Postmark topology"). This is
// the same posture as the conversations send route — preserved deliberately.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const validation = await validateBody(request, ReplySchema)
  if (!validation.ok) return validation.response
  const { text, internal } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  const now = new Date().toISOString()

  // ── Internal note — write it, send nothing ────────────────────────
  if (internal) {
    const { data: note, error: noteErr } = await db.from('email_inbox_messages').insert({
      ticket_id: ticket.id,
      contact_id: ticket.contact_id || null,
      location_id: ticket.location_id,
      direction: 'outbound',
      // No author column exists on this table, so from_email records WHO
      // wrote the note. On a real reply it stays the Postmark From, which is
      // what actually went on the wire.
      from_email: user.email || null,
      to_email: null,
      subject: ticket.subject || null,
      text_body: text,
      is_internal_note: true,
      source: 'operator',
      status: 'note',
    }).select('*').single()
    if (noteErr) return NextResponse.json({ success: false, error: noteErr.message }, { status: 500 })

    // The ticket is deliberately untouched: last_message_preview is the
    // member-visible correspondence, and a note must not re-describe the
    // queue row or move it up the list.
    return NextResponse.json({ success: true, data: { message: note, status: ticket.status, internal: true } })
  }

  // ── Real reply ────────────────────────────────────────────────────
  if (!ticket.requester_email) {
    return NextResponse.json({ success: false, error: 'No recipient address for this ticket' }, { status: 400 })
  }

  // Thread off the last thing the member sent us, so the reply lands in their
  // existing mail-client thread rather than starting a new one.
  const { data: lastInbound } = await db.from('email_inbox_messages')
    .select('rfc_message_id, references_header, subject')
    .eq('ticket_id', ticket.id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const subject = replySubject(lastInbound?.subject || ticket.subject)
  const headers = buildReplyHeaders({
    rfcMessageId: lastInbound?.rfc_message_id || null,
    referencesHeader: lastInbound?.references_header || null,
  })

  let result
  try {
    result = await sendEmail({
      to: ticket.requester_email,
      subject,
      htmlBody: textToHtml(text),
      textBody: text,
      // Reply-To is the ticket's OWN mailbox, so the member's next reply comes
      // back to the address they wrote to and threads onto this ticket. A
      // ticket with no mailbox (an elevated caller answering correspondence
      // whose address was deleted) still sends — their reply just lands on the
      // From mailbox instead of back in the queue.
      //
      // From stays POSTMARK_FROM_EMAIL (sendEmail's default). Sending FROM the
      // mailbox address needs per-domain DKIM that is not universally in place
      // — un-aligned SPF/DKIM would land support replies in spam — so it is a
      // later plan, not a one-line change here.
      replyTo: mailbox?.address || undefined,
      stream: 'outbound',
      tag: 'ticket-reply',
      metadata: { ticket_id: ticket.id, contact_id: ticket.contact_id || '' },
      headers,
    })
  } catch (err) {
    // Send failed → the ticket does NOT advance to pending. A queue that says
    // "waiting on the member" when the member was never written to is the
    // worst possible lie for a support tool to tell.
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }

  const { data: message, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticket.id,
    contact_id: ticket.contact_id || null,
    location_id: ticket.location_id,
    direction: 'outbound',
    from_email: process.env.POSTMARK_FROM_EMAIL || null,
    to_email: ticket.requester_email,
    subject,
    text_body: text,
    postmark_message_id: result.messageId,
    in_reply_to: lastInbound?.rfc_message_id || null,
    is_internal_note: false,
    source: 'operator',
    status: 'sent',
    sent_at: now,
  }).select('*').single()
  if (msgErr) return NextResponse.json({ success: false, error: msgErr.message }, { status: 500 })

  // Log to email_sends so the reply shows in the contact's email history, the
  // delivery webhooks can track it, and a later reply from the member matches
  // back to this contact via postmark_message_id. contact_id is NOT NULL
  // there, so an unlinked requester skips the log — the message row above is
  // still the operator-facing record.
  if (ticket.contact_id) {
    await db.from('email_sends').insert({
      contact_id: ticket.contact_id,
      location_id: ticket.location_id,
      source_type: 'inbox_reply',
      subject,
      from_email: process.env.POSTMARK_FROM_EMAIL,
      to_email: ticket.requester_email,
      postmark_message_id: result.messageId,
      postmark_stream: 'outbound',
      status: 'sent',
    })
  }

  // We answered → the ball is with the member. Nothing auto-closes from here
  // (Richard, 2026-08-06): a ticket ages in `pending` until someone replies or
  // an operator closes it.
  const patch = {
    status: 'pending',
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: inboundPreview(text),
    updated_at: now,
    ...statusTimestamps('pending', ticket, now),
  }
  if (shouldStampFirstResponse({
    firstResponseAt: ticket.first_response_at,
    direction: 'outbound',
    isInternalNote: false,
  })) {
    patch.first_response_at = now
  }
  await db.from('email_tickets').update(patch).eq('id', ticket.id)

  return NextResponse.json({
    success: true,
    data: { message, status: 'pending', message_id: result.messageId },
  })
}
