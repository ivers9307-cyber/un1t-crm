import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike, email as emailAddress } from '@/lib/schemas'
import { sendTicketEmail, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { normalizeEmail, pickContact, inboundPreview } from '@/lib/email-inbox'
import { ticketSubject } from '@/lib/email-tickets'
import { escapeLikePattern } from '@/lib/like-escape'
import { loadVisibleMailboxes, ticketNotFound } from '../_helpers'

// POST /api/email/tickets/compose — start a conversation (EMAIL-TICKET.5).
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHAT A "NEW EMAIL" IS
// A TICKET WHOSE FIRST MESSAGE IS OUTBOUND. There is no second concept here:
// one composed email creates one email_tickets row plus one outbound
// email_inbox_messages row, and from that moment it is an ordinary ticket —
// the same queue, the same status lifecycle, the same reply box. The
// recipient's answer threads back into it through the normal inbound path
// (Postmark's outbound RFC Message-ID embeds the API MessageID stored below,
// which is exactly what the webhook matches on).
//
// THE GATE. Service-role client, so RLS does nothing: this code IS the gate,
// and it has two levels, the same two every other ticket route applies.
// `email_inbox` gates the surface; a row in email_mailbox_access gates each
// individual account. The second one is what stops someone with sales@ sending
// as accounts@ — the sender may only ever pick a mailbox that comes back from
// loadVisibleMailboxes, and the mailbox object used from there on is the one
// THAT returned, not the one the caller named.
//
// A mailbox the caller cannot use is a 404, never a 403 — same as the detail
// routes, so mailbox ids can't be probed and the set of addresses a studio
// runs can't be enumerated.
//
// EMAIL-TICKET-CLEANUP.1 — BOTH gates now resolve at the MAILBOX'S location.
// The surface gate used to be hasPermission(), evaluated against the caller's
// ACTIVE location, which is not where the mail would have gone: this route
// never takes a location, it reads one off the mailbox. So a manager at
// Stillorgan whose session pointed there could compose FROM a Hatch address
// they hold no key for, and the same person with their session on Hatch was
// refused their own studio's composer. It cannot sit above the mailbox read
// (there is no location to resolve against yet), so it sits below it, and
// refuses with the same 404 as an unusable mailbox — a 403 here would separate
// "that mailbox exists, elsewhere" from "no such mailbox" and hand back the
// enumeration this route is careful not to give.

const ComposeSchema = z.object({
  mailbox_id: uuidLike,
  // Trim + lowercase BEFORE validating, so the shared `email` block judges the
  // normalised value and the row we store matches what the webhook will
  // compare against on the way back in.
  to: z.string().trim().toLowerCase().pipe(emailAddress),
  subject: z.string().trim().min(1).max(200),
  // Same cap as the reply route — one composer, one limit.
  text: z.string().trim().min(1).max(10000),
})

// At most this many contacts share one address (in practice one — contacts.email
// carries a GLOBAL unique index), but every select caps at 1,000 rows whatever
// the caller asks for, so the bound is stated.
const CONTACT_MATCH_LIMIT = 50

// Minimal text → HTML, identical to the reply route: a 1:1 human email is
// escaped text with line breaks, not designed mail.
//
// TODO(EMAIL-TICKET.5): collapses into the shared email-html helper once the
// sibling HTML plan lands — deliberately duplicated rather than imported
// against a module that does not exist on this branch yet.
function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${escaped}</div>`
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ComposeSchema)
  if (!validation.ok) return validation.response
  const { mailbox_id: mailboxId, to, subject, text } = validation.data

  const db = createServerClient()

  // ── The mailbox decides the location, and the location decides nothing ──
  // The caller does NOT get to name a location: it is read off the mailbox, so
  // the ticket can only ever land at the studio that owns the sending address.
  // Reading the row first is unavoidable (we need its location to resolve the
  // caller's visible set) — but nothing is trusted from it until both gates
  // below have passed.
  const { data: named, error: mailboxErr } = await db.from('email_mailboxes')
    .select('id, location_id')
    .eq('id', mailboxId)
    .maybeSingle()
  if (mailboxErr || !named) return ticketNotFound()

  const guard = assertLocationAccessOr404(user, named.location_id)
  if (guard) return guard

  // THE SURFACE GATE, at the mailbox's location — see the header. It runs after
  // assertLocationAccessOr404 so the broader refusal wins first, and before the
  // visible-set query so a caller with no key does no further work.
  if (!hasPermissionForLocation(user, named.location_id, 'email_inbox')) {
    return ticketNotFound()
  }

  // THE PER-ACCOUNT GATE. `mailboxes` is the caller's own visible set — active
  // mailboxes at this location that they are elevated over or hold a grant on.
  // Everything downstream uses THIS row, so an inactive or ungranted address
  // cannot be sent from even though it exists.
  const visibility = await loadVisibleMailboxes(db, user, named.location_id)
  // A FAILED visibility lookup is not "no mailboxes" (EMAIL-TICKET-CLEANUP.2).
  // Left as an empty set it 404'd — telling the operator the address they just
  // picked does not exist. Nothing has been sent at this point, so refusing
  // costs a retry and can never produce a wrong outcome.
  if (visibility.response) return visibility.response
  const mailbox = visibility.mailboxes.find(m => m.id === mailboxId) || null
  if (!mailbox) return ticketNotFound()

  const locationId = mailbox.location_id

  // ── Link a contact if the recipient is one ────────────────────────
  // Same resolution as the inbound webhook (pickContact), deliberately: a
  // ticket we start and a ticket they start must agree on who the member is.
  //
  // `_` is an ILIKE wildcard AND a legal email character, so an unescaped
  // `a_b@x.com` also matches `axb@x.com` server-side — filing a ticket against
  // the wrong member is far worse than filing it against nobody.
  // escapeLikePattern makes the QUERY mean what it says (ILIKE-WILDCARD.1 fixed
  // the same shape in the inbound webhook and six other lookups); the JS
  // re-check below stays as defence in depth, so a future edit to either line
  // alone cannot reopen the hole.
  //
  // `%` never gets this far on THIS route — `to` is validated by the strict
  // Zod email schema, which rejects a `%` local part. The inbound webhook has
  // no such gate (it parses the sender with the permissive normalizeEmail
  // regex), which is why the `%@domain` variant was live there and not here.
  //
  // EMAIL-TICKET.6 — `.error` is inspected. Swallowing it filed the ticket
  // against NOBODY: no contact link, no email_sends row, so the member's own
  // history silently omitted an email we sent them and their reply threaded
  // back to an unlinked ticket. Same ordering argument as the reply route —
  // this runs BEFORE the send, so refusing costs a retry and nothing else.
  const { data: candidates, error: candidatesErr } = await db.from('contacts')
    .select('id, location_id, email, created_at')
    .ilike('email', escapeLikePattern(to))
    .limit(CONTACT_MATCH_LIMIT)
  if (candidatesErr) {
    console.error('[tickets/compose] contact lookup failed BEFORE sending:', candidatesErr.message)
    return NextResponse.json({ success: false, error: candidatesErr.message }, { status: 500 })
  }
  const exact = (candidates || []).filter(c => normalizeEmail(c.email) === to)
  const contact = pickContact(exact, locationId)

  // ── SEND FIRST, THEN WRITE ────────────────────────────────────────
  // Ordering is deliberate and matches the reply route. A ticket sitting in
  // the queue for an email that never went out is the worst lie this tool can
  // tell — an operator sees "we emailed them" and stops chasing. Sending
  // first makes that state unreachable: a failed send returns 400 with nothing
  // written at all, so there is no orphan to clean up and no cleanup path that
  // can itself fail.
  //
  // The residual risk runs the other way — a send that succeeds and a write
  // that then fails — and it is the cheaper one: the email genuinely reached
  // the member, their reply still lands (the inbound webhook mints a fresh
  // ticket when nothing threads), and the errors below say plainly that the
  // mail went out so nobody re-sends it blind.
  //
  // TODO(EMAIL-TICKET.5): append the sender's signature here once the reply
  // route's per-profile signature helper exists — one call, both paths, no
  // second copy of the rule.
  // EMAIL-OUTBOUND-SERVER.1 — sent FROM the chosen mailbox, on the support
  // inbox's own Postmark server and stream, with Reply-To that same mailbox so
  // the answer threads back onto this ticket. Same call as the reply route;
  // changing it is one change for both.
  const send = await sendTicketEmail({
    mailboxAddress: mailbox.address,
    to,
    subject,
    htmlBody: textToHtml(text),
    textBody: text,
    tag: 'ticket-compose',
    metadata: { mailbox_id: mailbox.id, contact_id: contact?.id || '' },
  })
  if (!send.ok) {
    // 503 = our ticketing server is unconfigured (retry unchanged once it is);
    // 400 = Postmark refused this message. Either way nothing was written.
    return NextResponse.json(
      { success: false, error: send.error },
      { status: send.reason === 'not_configured' ? 503 : 400 }
    )
  }
  const result = send.result

  const now = new Date().toISOString()

  const { data: ticket, error: ticketErr } = await db.from('email_tickets').insert({
    // Both come off the mailbox, never off the request.
    location_id: locationId,
    mailbox_id: mailbox.id,
    contact_id: contact?.id || null,
    requester_email: to,
    subject: ticketSubject(subject, null),
    // `open`, not `pending`: we started this, so it is ours to chase until
    // they answer. `pending` means "waiting on the member" and belongs to a
    // ticket they opened. This also keeps it out of the needs_reply view,
    // which filters on an INBOUND last message.
    status: 'open',
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: inboundPreview(text),
    // This outbound IS the first response — there was never anything to
    // respond to, and a support metric that counts this ticket as unanswered
    // forever would be worse than not counting it at all.
    first_response_at: now,
  }).select('*').single()
  if (ticketErr || !ticket) {
    console.error('[tickets/compose] ticket insert failed AFTER a successful send:', ticketErr?.message)
    return NextResponse.json({
      success: false,
      error: 'The email was sent but could not be filed as a ticket. Do not resend — check with the recipient before trying again.',
    }, { status: 500 })
  }

  const { data: message, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticket.id,
    contact_id: contact?.id || null,
    location_id: locationId,
    direction: 'outbound',
    // The From that actually went on the wire — the mailbox's own address, or
    // a domain we own when that mailbox has no verified sender signature.
    from_email: send.fromEmail || null,
    to_email: to,
    subject,
    text_body: text,
    postmark_message_id: result.messageId,
    // mig 493 — WHO wrote it. On a shared queue an anonymous "outbound" is the
    // difference between a conversation and a pile of text.
    author_profile_id: user.id,
    is_internal_note: false,
    source: 'operator',
    status: 'sent',
    sent_at: now,
  }).select('*').single()
  if (msgErr) {
    // The ticket STAYS. It carries last_message_preview, so the queue still
    // shows what was sent and to whom — deleting it would erase the only
    // record of an email that genuinely went out.
    console.error('[tickets/compose] message insert failed AFTER a successful send:', msgErr.message)
    return NextResponse.json({
      success: false,
      error: 'The email was sent and the ticket created, but the message could not be filed. Do not resend.',
      data: { ticket_id: ticket.id },
    }, { status: 500 })
  }

  // Log to email_sends so the email shows in the contact's history, the
  // delivery webhooks can track it, and a reply matches back to this contact
  // via postmark_message_id. contact_id is NOT NULL there, so an unlinked
  // recipient skips the log — the message row above is still the record.
  //
  // postmark_stream is THIS APP'S 'outbound' (the shared constant), never the
  // Postmark message stream id the message rode — see the reply route for the
  // full reasoning.
  if (contact?.id) {
    await db.from('email_sends').insert({
      contact_id: contact.id,
      location_id: locationId,
      source_type: 'inbox_compose',
      subject,
      from_email: send.fromEmail,
      to_email: to,
      postmark_message_id: result.messageId,
      postmark_stream: TICKET_INTERNAL_STREAM,
      status: 'sent',
    })
  }

  return NextResponse.json({
    success: true,
    data: { ticket_id: ticket.id, ticket, message, message_id: result.messageId },
  })
}
