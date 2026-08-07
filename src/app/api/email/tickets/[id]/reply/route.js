import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendEmail } from '@/lib/postmark'
import { replySubject, buildReplyHeaders, inboundPreview } from '@/lib/email-inbox'
import { shouldStampFirstResponse } from '@/lib/email-tickets'
import { appendSignature } from '@/lib/email-signature'
import { loadTicketForUser, statusTimestamps } from '../../_helpers'

const ReplySchema = z.object({
  text: z.string().trim().min(1).max(10000),
  // An internal note is staff-to-staff on the ticket. It is written to the
  // thread and NOTHING is sent — the member never sees it, so it also never
  // stamps first_response_at and never advances the ticket.
  internal: z.boolean().optional().default(false),
})

// Minimal text → HTML, same as the legacy conversations send route this
// replaced: a 1:1 human reply is escaped text with line breaks, not designed
// mail.
//
// EMAIL-TICKET.5: this runs over the body WITH the signature already appended
// (see appendSignature), so the sign-off is escaped by exactly the same three
// replacements as the operator's own words. That ordering is the whole safety
// story for signatures — escape-then-concatenate would hand an operator a raw
// HTML injection point into outbound mail.
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
// the same posture as the legacy conversations send route — preserved
// deliberately.
//
// EMAIL-TICKET.5 adds two things (mig 493):
//   • the sender's plain-text signature on real replies, never on notes
//   • author_profile_id on BOTH replies and notes (inbound has no author)
//
// EMAIL-CONV-STOP.1 (2026-08-07) removed the third: a non-fatal mirror that
// stamped conversation_id onto the outbound message row and refreshed the mig
// 394 email_conversations summary, so a reply also showed on the old unified
// inbox. That surface is gone (INBOX-SPLIT.1 dropped email from the web
// inbox; EMAIL-TICKET-M.1 moved mobile onto tickets), and the webhook no
// longer writes a conversation for it to find. The mirror was already
// non-fatal, so nothing about the reply path's behaviour changes — only the
// response's now-always-null `conversation_id` field is gone with it.
//
// EMAIL-TICKET-CLEANUP.1 moved the `email_inbox` gate OUT of this route and
// into loadTicketForUser, where it resolves at the TICKET'S location. Sitting
// here it could only ever resolve at the caller's ACTIVE location, so a manager
// at one studio who is merely staff at another could REPLY AS the second studio
// — real mail, on the wire, on correspondence they hold no key for. Of the
// routes that carried the same mistake this is the one where it wrote to the
// outside world rather than only reading.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

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
      // WHO wrote it (mig 493). Set on notes as well as replies — on a shared
      // queue "who left this note" is the whole point of a note.
      author_profile_id: user.id,
      // from_email still records the author's address for anything reading
      // rows written before mig 493. On a real reply it stays the Postmark
      // From, which is what actually went on the wire.
      from_email: user.email || null,
      to_email: null,
      subject: ticket.subject || null,
      // NOT signed (EMAIL-TICKET.5). A note is sent to nobody, so a sign-off
      // on it is noise on a staff-only line — appendSignature is deliberately
      // absent from this branch.
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
  //
  // EMAIL-TICKET.6 — `.error` is inspected. Swallowing it degraded silently:
  // no In-Reply-To/References, so every reply started a NEW thread in the
  // member's client while the operator saw a normal send. NOTHING HAS BEEN SENT
  // YET at this point, so refusing costs a retry and can never produce a wrong
  // outcome — the ordering is what makes 500 the safe answer here.
  const { data: lastInbound, error: lastInboundErr } = await db.from('email_inbox_messages')
    .select('rfc_message_id, references_header, subject')
    .eq('ticket_id', ticket.id)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastInboundErr) {
    console.error('[tickets/reply] threading lookup failed BEFORE sending:', lastInboundErr.message)
    return NextResponse.json({ success: false, error: lastInboundErr.message }, { status: 500 })
  }

  const subject = replySubject(lastInbound?.subject || ticket.subject)
  const headers = buildReplyHeaders({
    rfcMessageId: lastInbound?.rfc_message_id || null,
    referencesHeader: lastInbound?.references_header || null,
  })

  // EMAIL-TICKET.5 — sign off as whoever is sending.
  //
  // getCurrentUser() spreads the whole profiles row, so email_signature is the
  // SENDER'S own (and, under impersonation, the impersonated profile's — the
  // same identity that goes into author_profile_id below, so the two can't
  // disagree). A NULL/empty signature appends nothing at all, which is every
  // reply the system has sent so far.
  //
  // Built BEFORE the HTML conversion so textToHtml escapes body and signature
  // in one pass — see the note on textToHtml.
  const outboundText = appendSignature(text, user.email_signature)

  let result
  try {
    result = await sendEmail({
      to: ticket.requester_email,
      subject,
      htmlBody: textToHtml(outboundText),
      textBody: outboundText,
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
    // WHO sent it (mig 493). from_email stays the Postmark From, which is what
    // actually went on the wire — it is not an author field.
    author_profile_id: user.id,
    from_email: process.env.POSTMARK_FROM_EMAIL || null,
    to_email: ticket.requester_email,
    subject,
    // The SIGNED body — the message row is the record of what the member
    // received, so it must not show a shorter message than was sent.
    text_body: outboundText,
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

  // Preview is the operator's OWN words, unsigned — a queue row that reads
  // "-- Sarah, UN1T Stillorgan" instead of what was actually said would make
  // every short reply look identical in the list.
  const preview = inboundPreview(text)

  // We answered → the ball is with the member. Nothing auto-closes from here
  // (Richard, 2026-08-06): a ticket ages in `pending` until someone replies or
  // an operator closes it.
  const patch = {
    status: 'pending',
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: preview,
    updated_at: now,
    ...statusTimestamps('pending', ticket, now),
  }
  // Only ever on a real outbound send: the internal-note branch above returns
  // long before this and never touches email_tickets at all, so a note can
  // neither stamp a first response nor move the ticket.
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
