import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, email as emailAddress } from '@/lib/schemas'
import { sendTicketEmail, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { appendSignature } from '@/lib/email-signature'
import { normalizeEmail, pickContact, inboundPreview } from '@/lib/email-inbox'
import { ticketSubject } from '@/lib/email-tickets'
import { escapeLikePattern } from '@/lib/like-escape'
import { logAuditEvent } from '@/lib/audit'
import {
  MAX_RECIPIENTS,
  resolveRecipients,
  toPostmarkFields,
  newRecipients,
} from '@/lib/email-recipients'
import {
  collectOutboundAttachments,
  fileOutboundAttachments,
  outboundAttachmentsField,
} from '@/lib/email-outbound-attachments-server'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { withSendMarker } from '@/lib/postmark-send-marker'
import { loadSendingMailbox, loadOwnAddresses } from '../_helpers'

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

// Trim + lowercase BEFORE validating, so the shared `email` block judges the
// normalised value and the row we store matches what the webhook will compare
// against on the way back in.
const oneAddress = z.string().trim().toLowerCase().pipe(emailAddress)

// EMAIL-CC.1 — bounded at parse time so a 10,000-element array is refused
// before any of it is normalised. resolveRecipients then enforces the real cap
// across To + Cc + Bcc combined.
const addressList = z.array(oneAddress).max(MAX_RECIPIENTS)

const ComposeSchema = z.object({
  mailbox_id: uuidLike,
  // EMAIL-CC.1 — several recipients. The SCALAR FORM IS STILL ACCEPTED and
  // normalised to a one-element array: the composer is not the only thing that
  // could ever post here, and quietly 400-ing a shape that worked yesterday is
  // not a change anyone would connect to a Cc feature.
  to: z.union([oneAddress.transform(a => [a]), addressList.min(1)]),
  cc: addressList.optional().default([]),
  bcc: addressList.optional().default([]),
  subject: z.string().trim().min(1).max(200),
  // Same cap as the reply route — one composer, one limit.
  text: z.string().trim().min(1).max(10000),
  // EMAIL-OUTBOUND-ATTACH.1 — references to files the browser already uploaded
  // straight to Storage, never the bytes (Vercel 413s a body over ~4.5 MB
  // before this handler runs). Same field, same rules as the reply route.
  attachments: outboundAttachmentsField,
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
  const {
    mailbox_id: mailboxId,
    to: rawTo, cc: rawCc, bcc: rawBcc,
    subject, text,
    attachments: drafts,
  } = validation.data

  const db = createServerClient()

  // ── The mailbox decides the location, and the location decides nothing ──
  // Both gates, in order, in one place: the mailbox row is read first (the
  // caller does NOT get to name a location — it comes off the mailbox, so the
  // ticket can only land at the studio that owns the sending address), then
  // location access, then `email_inbox` AT THAT LOCATION, then the per-account
  // visible-set check. Everything downstream uses the row loadSendingMailbox
  // returned, never the id the caller named.
  //
  // EMAIL-OUTBOUND-ATTACH.1 moved this block verbatim into _helpers.js because
  // the attachment upload-sign route has to answer the identical question — an
  // upload for a new email is authorised against the mailbox it will be sent
  // from. Two copies would be two definitions of who may send as `accounts@`.
  const sender = await loadSendingMailbox(db, user, mailboxId)
  if (sender.response) return sender.response
  const { mailbox, locationId } = sender

  // ── Who this reaches (EMAIL-CC.1) ─────────────────────────────────
  // Our own addresses are excluded from all three lists. Cc'ing one of our
  // mailboxes would deliver a copy to our own inbound webhook, which files it
  // as a brand-new ticket at the same studio — a phantom enquiry, from us, on
  // every composed email. See loadOwnAddresses.
  const own = await loadOwnAddresses(db)
  if (own.response) return own.response

  const recipients = resolveRecipients({
    to: rawTo, cc: rawCc, bcc: rawBcc, exclude: own.addresses,
  })
  if (!recipients.ok) {
    return NextResponse.json({ success: false, error: recipients.error }, { status: 400 })
  }
  const wire = toPostmarkFields(recipients)
  // The PRIMARY recipient. One ticket has one counterpart: it is who
  // requester_email names, who the contact link resolves against and who a
  // later reply threads back from. Cc'd people are on the correspondence, not
  // the subject of the ticket.
  const to = recipients.to[0]

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

  // EMAIL-OUTBOUND-ATTACH.1 — read the draft objects back out of Storage and
  // turn them into Postmark's array, BEFORE the send. Every way an attachment
  // can be refused has to be a refusal to send at all: a ticket in the queue
  // showing files the recipient never got is the same lie as a ticket for an
  // email that never went. Nothing is written or sent at this point.
  const collected = await collectOutboundAttachments(db, { drafts, profileId: user.id })
  if (!collected.ok) {
    return NextResponse.json({ success: false, error: collected.error }, { status: 400 })
  }

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
  // EMAIL-CC.1 — all three lists via toPostmarkFields(), the single site where
  // a resolved set becomes wire values. Bcc reaches Postmark's own Bcc field
  // and nothing else. Note the WIRE strings go out while the ticket below is
  // filed against `to` (= recipients.to[0]), the primary recipient.
  //
  // EMAIL-OUTBOUND-SERVER.1 — sent FROM the chosen mailbox, on the support
  // inbox's own Postmark server and stream, with Reply-To that same mailbox so
  // the answer threads back onto this ticket. Same call as the reply route;
  // changing it is one change for both.
  // The sender's sign-off, exactly as the reply route builds it: appended
  // BEFORE the HTML conversion so textToHtml escapes body and signature in one
  // pass, and stored below so the row records what was actually sent. A
  // composed email is a ticket whose first message is outbound — not a second
  // concept — so it does not get a second signature rule either.
  const outboundText = appendSignature(text, user.email_signature)

  const send = await sendTicketEmail({
    mailboxAddress: mailbox.address,
    // MAILBOX-CONNECT.7 — the mailbox ROW, not just its address. sendTicketEmail
    // reads `egress` off it to choose the transport; a mailbox connected over
    // IMAP/SMTP sends as its own address over its own SMTP, because Postmark
    // cannot DKIM-sign a domain we do not control. Omitting this is not a
    // degraded send, it is silently the wrong sender — which is why every call
    // site passes it rather than the send path defaulting.
    mailbox,
    to: wire.to,
    cc: wire.cc,
    bcc: wire.bcc,
    subject,
    htmlBody: textToHtml(outboundText),
    textBody: outboundText,
    tag: 'ticket-compose',
    // POSTMARK-RACE.1 — marked iff `sendLogRow` will be built, which is the
    // same `contact?.id` condition. An outbound ticket mail to an address with
    // no contact writes no email_sends row and must stay unmarked.
    metadata: contact?.id
      ? withSendMarker({ mailbox_id: mailbox.id, contact_id: contact.id })
      : { mailbox_id: mailbox.id, contact_id: '' },
    // undefined when there are none, so the Postmark payload is byte-identical
    // to every email this route has ever sent.
    attachments: collected.postmark,
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

  // ── The record of the send — built BEFORE the filing inserts ──────
  // From here on the email is with the recipient; everything below is
  // bookkeeping about a send that already happened, and either filing insert
  // can still fail. Built up front so the failure branches write the same
  // record the happy path would have (EMAIL-COMPOSE-UNFILED.1, mirroring
  // EMAIL-REPLY-UNFILED.1 on the reply route).
  //
  // The email_sends row: the contact's history, delivery-webhook correlation,
  // and how a reply matches back to this contact via postmark_message_id.
  // contact_id is NOT NULL there, so an unlinked recipient gets no row (null
  // here). postmark_stream is THIS APP'S 'outbound' (the shared constant),
  // never the Postmark message stream id the message rode — see the reply
  // route for the full reasoning.
  const sendLogRow = contact?.id ? {
    contact_id: contact.id,
    location_id: locationId,
    source_type: 'inbox_compose',
    subject,
    from_email: send.fromEmail,
    to_email: to,
    postmark_message_id: result.messageId,
    postmark_stream: TICKET_INTERNAL_STREAM,
    status: 'sent',
  } : null

  // EMAIL-COMPOSE-UNFILED.1 — the delivered send has to be recorded SOMEWHERE
  // when a filing insert fails, because the rows that should have been its
  // record don't exist: in the ticket-insert case NOTHING referenced it at
  // all. Dead letter carries everything a human re-files from; provider is
  // deliberately NOT a REPLAYABLE_PROVIDERS key (a replay of a send that
  // already happened would BE the double-send); location-stamped so
  // integration health counts it. Best-effort by construction — a DB bad
  // enough to fail these too must still not turn "already sent" back into a
  // retryable-looking error.
  async function recordUnfiledSend({ ticketId, error }) {
    try {
      await deadLetterWebhook(db, {
        provider: 'email_ticket_compose',
        eventType: 'sent_not_filed',
        payload: {
          ticket_id: ticketId,
          mailbox_id: mailbox.id,
          postmark_message_id: result.messageId,
          // MAILBOX-CONNECT.7 — this payload is the re-fileable record, so it
          // has to carry what a re-file needs. On the SMTP path the RFC id is
          // the ONLY threading key that exists.
          rfc_message_id: result.rfcMessageId || null,
          from_email: send.fromEmail || null,
          recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
          subject,
          // The SIGNED body — this payload is the re-fileable record of what
          // the member actually received.
          text_body: outboundText,
          contact_id: contact?.id || null,
          author_profile_id: user.id,
          sent_at: now,
        },
        error,
        locationId,
      })
      if (sendLogRow) await db.from('email_sends').insert(sendLogRow)
    } catch (e) {
      console.error('[tickets/compose] breadcrumbs after the unfiled send also failed:', e?.message)
    }
  }

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
    await recordUnfiledSend({ ticketId: null, error: ticketErr })
    return NextResponse.json({
      success: false,
      error: 'The email was sent but could not be filed as a ticket. Do not resend — check with the recipient before trying again.',
      // Machine-readable, so the composer can tell this 500 from every other
      // without string-matching the copy (same contract as the reply route).
      data: { sent: true, message_id: result.messageId },
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
    // to_email stays the PRIMARY recipient; to_emails carries the rest (mig
    // 499). bcc_emails is written here and read back by nothing — not the
    // reply route, not the forward that reuses this recipient model.
    to_email: to,
    to_emails: recipients.to,
    cc_emails: recipients.cc,
    bcc_emails: recipients.bcc,
    subject,
    text_body: outboundText,
    postmark_message_id: result.messageId,
    // MAILBOX-CONNECT.7 — THE THREADING KEY ON THE SMTP PATH, and the reason a
    // reply to a connected mailbox lands on this ticket instead of forking a
    // new one.
    //
    // The inbound webhook resolves a thread by matching the incoming
    // In-Reply-To/References against BOTH email_inbox_messages.rfc_message_id
    // and .postmark_message_id (route.js ~740). A Postmark send is covered by
    // the second: Postmark mints the RFC id and embeds its API MessageID in it,
    // which is what `result.messageId` above stores.
    //
    // An SMTP send has no Postmark id at all — sendViaSmtp returns
    // `messageId: null` on purpose, because no provider event will ever arrive
    // for it. So without this line an SMTP-sent message matches NEITHER column,
    // and every customer reply to it opens a brand new ticket while the
    // original sits unanswered. Nodemailer returns the RFC id it actually
    // generated; store it.
    //
    // NULL on the Postmark path (sendEmail does not report the RFC id), which
    // is exactly today's behaviour — this is purely additive.
    rfc_message_id: result.rfcMessageId || null,
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
    await recordUnfiledSend({ ticketId: ticket.id, error: msgErr })
    return NextResponse.json({
      success: false,
      error: 'The email was sent and the ticket created, but the message could not be filed. Do not resend.',
      data: { sent: true, ticket_id: ticket.id, message_id: result.messageId },
    }, { status: 500 })
  }

  // EMAIL-OUTBOUND-ATTACH.1 — the studio's own copy of the files that just
  // went out, and the bytes it is billed for. Never throws, never fails the
  // response: the email is already with the recipient.
  await fileOutboundAttachments(db, {
    files: collected.files,
    messageId: message.id,
    locationId,
    mailboxId: mailbox.id,
  })

  // Log to email_sends — the row was built above, before the filing inserts;
  // see the sendLogRow comment for everything it is and is not.
  if (sendLogRow) {
    await db.from('email_sends').insert(sendLogRow)
  }

  // ── Attribution (EMAIL-CC.1) ──────────────────────────────────────
  // EVERY address on a composed email is one a staff member typed — nobody
  // wrote to us first — so the whole set is logged, not just the extras. This
  // is the deliberate half of the "adding a stranger" answer: there is no
  // consent gate on ticket mail (it is transactional, Richard), so instead the
  // act is capped, validated and attributable. logAuditEvent never throws.
  await logAuditEvent({
    category: 'business',
    action: 'email_ticket.composed',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `email_ticket/${ticket.id}`, label: subject },
    locationId,
    details: {
      added: newRecipients(recipients, []),
      recipient_count: recipients.count,
      mailbox_id: mailbox.id,
    },
    request,
  })

  return NextResponse.json({
    success: true,
    data: {
      ticket_id: ticket.id,
      ticket,
      message,
      message_id: result.messageId,
      // Confirms what went out. bcc is included because the sender is staff on
      // the ticket they just created; it goes no further than this response.
      recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
    },
  })
}
