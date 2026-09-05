import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendTicketEmail } from '@/lib/email-inbox-send'
import { appendSignature, resolveSendSignature } from '@/lib/email-signature'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { logAuditEvent } from '@/lib/audit'
import { uuidLike, email as emailAddress } from '@/lib/schemas'
import {
  MAX_RECIPIENTS,
  resolveRecipients,
  toPostmarkFields,
  newRecipients,
} from '@/lib/email-recipients'
import {
  forwardSubject,
  buildForwardText,
  forwardRefusal,
  selectForwardAttachments,
} from '@/lib/email-forward'
import {
  collectForwardAttachments,
  fileForwardedAttachments,
} from '@/lib/email-forward-server'
import { MAX_OUTBOUND_ATTACHMENTS } from '@/lib/email-outbound-attachments'
import { loadTicketForUser, loadOwnAddresses, ticketMergedAway , loadSignatureContext } from '../../_helpers'

// POST /api/email/tickets/[id]/forward — pass one message on the ticket to
// somebody else (EMAIL-FORWARD.1, mig 501).
//
// ══ 1. WHERE THE FORWARD LIVES: ON THIS TICKET ══════════════════════
// A forward is an OUTBOUND message on the SAME ticket as the message it
// quotes. Not a new ticket, not a "sent items" folder, not a note.
//
// The alternative — mint a ticket for the forward — splits one issue across
// two queue rows: the member's refund question in one, the accountant's answer
// in another, neither carrying the other's context. The record that matters is
// "we sent this to the accountant ABOUT THIS", and the only place that reads as
// one fact is the correspondence it is about. It also makes the accountant's
// reply land where it belongs: the forward's Reply-To is the ticket's own
// mailbox and its Postmark MessageID is stored on the message row, so their
// answer threads back onto THIS ticket through the ordinary inbound path — the
// same mechanism a composed email uses.
//
// WHAT THE THREAD SHOWS: an ordinary outbound bubble — "Sent to
// accountant@…", the sender's name, the recipient lines the reply route
// already renders (To/Cc, and Bcc marked staff-only) — plus a "Forwarded"
// marker naming the message it passed on, which is what mig 501's
// `forwarded_message_id` is for.
//
// ══ 2. THE TICKET IS DELIBERATELY NOT TOUCHED ═══════════════════════
// No status change, no last_message_at, no last_message_preview, no
// first_response_at. Same posture as an internal note, and for a stronger
// reason than tidiness: `needs_reply` is `status = 'open' AND
// last_message_direction = 'inbound'`, so stamping an outbound last message
// here would DROP THE TICKET OUT OF THE NEEDS-REPLY QUEUE. Forwarding a
// member's question to the accountant is not answering the member — they are
// still waiting, and the queue must keep saying so. Nor is a forward the
// ticket's first response: it went to a third party.
//
// ══ 3. RECIPIENTS ARE TYPED, NEVER DERIVED ═════════════════════════
// The opposite of a reply. A reply's recipients come from the thread; a
// forward's come from the operator, because choosing a new audience IS the
// act. So this route never derives an audience at all — no ticketParticipants()
// call, nothing off the thread — and, crucially,
// NOTHING ON THIS ROUTE READS `bcc_emails` OFF STORED CORRESPONDENCE. The
// SELECT below does not name the column (email-forward.test.js scans this
// file's source for it), and the quoted header block is a closed list of five
// headers that does not include Bcc (see src/lib/email-forward.js). A forward
// therefore reaches, and reveals, exactly the people it would have had the
// original's Bcc never been typed.
//
// Everything else about the recipient set is the shared model: validated,
// deduped case-insensitively across To/Cc/Bcc (To beats Cc beats Bcc), our own
// mailbox addresses excluded from all three, 25 addresses combined. The
// exclusion matters as much here as on a reply — forwarding to one of our own
// mailboxes would deliver into the inbound webhook and file a phantom ticket.
//
// ══ 4. INTERNAL NOTES CANNOT BE FORWARDED ══════════════════════════
// Refused with a 400, not hidden and hoped about. A note is staff-to-staff text
// that was never sent to anyone and is written on the assumption that only
// colleagues read it; mailing one to a third party under the studio's own
// address is the worst thing this surface could do. The thread hides the
// action on notes too — this is the gate, that is the affordance.
//
// ══ 5. NO email_sends ROW ═══════════════════════════════════════════
// Reply and compose log one, for the ticket's own contact. A forward must not:
// it goes to a THIRD PARTY, so a row against the member's contact_id would put
// "we emailed you" in the member's own history for mail they never received —
// and would count toward their engagement metrics. Delivery tracking is
// unaffected: mig 498 stamps delivery_status onto email_inbox_messages by
// postmark_message_id directly, not through email_sends.
//
// ══ 6. SEND BEFORE WRITE ════════════════════════════════════════════
// Same ordering as reply and compose, so every refusal — a missing message, a
// note, a bad address, an unreadable object, a set of files past Postmark's
// ceiling — happens with NOTHING sent and NOTHING written. The thread can
// never show a forward that did not go.

const addressList = z.array(z.string().trim().toLowerCase().pipe(emailAddress)).max(MAX_RECIPIENTS)

const ForwardSchema = z.object({
  // WHICH message. A forward is of one message, not of a whole thread — the
  // same unit every mail client forwards, and the only unit whose headers can
  // be quoted honestly.
  message_id: uuidLike,
  // Typed by the operator. `to` is required: a forward with only a Cc is not
  // an email anyone is being asked to read.
  to: addressList.min(1),
  cc: addressList.optional().default([]),
  bcc: addressList.optional().default([]),
  // The covering note. OPTIONAL — "here, look at this" is a legitimate forward
  // and demanding a sentence for it would get an empty full stop typed instead.
  note: z.string().trim().max(10000).optional().default(''),
  // WHICH of the original's files ride along. Ids of rows on the message being
  // forwarded — never paths, never bytes, and never a "send them all" boolean:
  // an explicit list is what makes "the operator chose" true rather than
  // asserted. The default is NONE, and the composer pre-ticks the full set
  // when it fits (see defaultForwardSelection).
  attachment_ids: z.array(uuidLike).max(MAX_OUTBOUND_ATTACHMENTS).optional().default([]),
})

// The columns a forward reads off the message it is quoting.
//
// `bcc_emails` IS ABSENT AND MUST STAY ABSENT. Not filtered later — never
// fetched. The quoted header block is built from this row, so a column that is
// not here cannot be reproduced by any amount of carelessness downstream.
// email-forward.test.js scans this file for the string.
//
// `html_body` IS fetched, and is read for exactly one thing: deciding whether
// to tell the recipient that formatting was dropped. It never reaches the wire
// — see FORWARDING IS PLAIN TEXT in src/lib/email-forward.js for why quoting a
// stranger's markup out of a sandboxed iframe and onto our own DKIM signature
// is the wrong trade.
const SOURCE_COLUMNS = [
  'id', 'ticket_id', 'direction',
  'from_email', 'to_email', 'to_emails', 'cc_emails',
  'subject', 'text_body', 'html_body',
  'is_internal_note', 'sent_at', 'created_at',
].join(', ')

// A message carries at most MAX_ATTACHMENTS_PER_MESSAGE (25) rows, but every
// .select() caps at 1,000 regardless, so the bound is stated.
const ATTACHMENT_LIMIT = 50

// Minimal text → HTML, identical to the reply and compose routes.
//
// THIS IS THE WHOLE ANSWER TO HOSTILE INBOUND HTML. The quoted body reaching
// this function is PLAIN TEXT (email_inbox_messages.text_body — Postmark's own
// TextBody, or htmlToPlainText of the HtmlBody when the sender supplied none),
// and these three replacements escape it. So a stranger's markup is not
// sanitised on its way onto the wire; it never becomes markup at all. That is
// strictly stronger than reusing email-html.js's sanitiser, whose permissiveness
// is bought by the sandboxed iframe it renders into — an iframe that does not
// exist in a recipient's mail client.
function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${escaped}</div>`
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ForwardSchema)
  if (!validation.ok) return validation.response
  const {
    message_id: messageId,
    to: rawTo, cc: rawCc, bcc: rawBcc,
    note,
    attachment_ids: attachmentIds,
  } = validation.data

  const db = createServerClient()

  // The ticket gate: location access, `email_inbox` AT THE TICKET'S location,
  // and a grant on the mailbox it arrived at. Every refusal is a 404.
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  // EMAIL-MERGE.6 — nothing leaves a tombstone. Before the source lookup and
  // well before the send, so a merged ticket cannot put a member's message in
  // front of a third party from a thread nobody is watching. The messages
  // themselves have moved to the survivor; forwarding one belongs there.
  if (ticket.merged_into_id) return ticketMergedAway(ticket)

  // ── The message being forwarded ───────────────────────────────────
  // Scoped to THIS ticket, so a message id from anywhere else in the estate
  // simply is not found — the caller learns nothing about whether it exists.
  const { data: source, error: sourceErr } = await db.from('email_inbox_messages')
    .select(SOURCE_COLUMNS)
    .eq('id', messageId)
    .eq('ticket_id', ticket.id)
    .maybeSingle()
  if (sourceErr) {
    // NOTHING HAS BEEN SENT. Refusing costs a retry; carrying on with a message
    // we could not read would forward an empty quote under the member's
    // subject line.
    console.error('[tickets/forward] source message lookup failed BEFORE sending:', sourceErr.message)
    return NextResponse.json({ success: false, error: sourceErr.message }, { status: 500 })
  }

  const refusal = forwardRefusal(source)
  if (refusal) {
    // 404 for "not on this ticket" (an id that may or may not exist elsewhere),
    // 400 for an internal note (an id that is plainly here and plainly not
    // forwardable — pretending it is missing would be a worse answer than the
    // sentence explaining why).
    return NextResponse.json(
      { success: false, error: refusal },
      { status: source ? 400 : 404 },
    )
  }

  // ── Who this reaches ──────────────────────────────────────────────
  const own = await loadOwnAddresses(db)
  if (own.response) return own.response

  const recipients = resolveRecipients({
    to: rawTo, cc: rawCc, bcc: rawBcc, exclude: own.addresses,
  })
  if (!recipients.ok) {
    return NextResponse.json({ success: false, error: recipients.error }, { status: 400 })
  }
  const wire = toPostmarkFields(recipients)

  // ── Which of the original's files ride along ──────────────────────
  // Every attachment row on the source message is read, including the ones
  // with no bytes: selectForwardAttachments has to be able to tell "not on this
  // message" from "on it, but never stored", and those are different sentences
  // for the operator.
  let chosen = []
  if (attachmentIds.length > 0) {
    const { data: attachmentRows, error: attachErr } = await db.from('email_ticket_attachments')
      // `forwarded_from_id` is selected because the message being forwarded may
      // itself BE a forward (the accountant's answer going on to the bank). The
      // new row must point at the row that OWNS the bytes, not at the reference
      // in front of it — see collectForwardAttachments for why the graph is
      // kept exactly one level deep.
      .select('id, filename, mime_type, size_bytes, storage_path, attachment_index, forwarded_from_id')
      .eq('message_id', source.id)
      .order('attachment_index', { ascending: true })
      .limit(ATTACHMENT_LIMIT)
    if (attachErr) {
      // Same ordering argument: nothing sent, so refusing is free. Falling back
      // to "forward it without the files" would send a forward the operator
      // believes carried an invoice.
      console.error('[tickets/forward] attachment lookup failed BEFORE sending:', attachErr.message)
      return NextResponse.json({
        success: false,
        error: 'Could not check the files on that message. Nothing was sent — try again.',
      }, { status: 500 })
    }
    const selected = selectForwardAttachments(attachmentRows || [], attachmentIds)
    if (!selected.ok) {
      return NextResponse.json({ success: false, error: selected.error }, { status: 400 })
    }
    chosen = selected.rows
  }

  // Read the SHARED objects back out of Storage — the originals, at their own
  // canonical keys. Nothing is copied and nothing is re-uploaded. BEFORE THE
  // SEND, so an unreadable object or a set past Postmark's ceiling is a refusal
  // to send at all rather than a forward missing half its files.
  const collected = await collectForwardAttachments(db, { rows: chosen })
  if (!collected.ok) {
    return NextResponse.json({ success: false, error: collected.error }, { status: 400 })
  }

  // ── The mail itself ───────────────────────────────────────────────
  // The signature goes on the NOTE, not on the whole body, so it lands where a
  // mail client puts it: after our own words and before the quoted message.
  // appendSignature returns the note unchanged when the sender has none, which
  // is most people.
  // MAIL-SIG.1 — with a rich signature the sign-off moves BELOW the whole
  // forward (Gmail's own placement) so the photo/link block never splits the
  // note from the forwarded content; the plain-text fallback keeps its old
  // in-note position byte-for-byte.
  // MAIL-SIGDEFAULT.1 — resolveSendSignature is THE decision, shared with
  // the /account preview and the composer hint: the personal rich block when
  // enabled, else the STUDIO block wherever the studio has configured one
  // (plain column above it, in the rich placement below the forward), else
  // null → the plain in-note path below, unchanged.
  const sigCtx = await loadSignatureContext(db, ticket.location_id)
  const richSig = resolveSendSignature(user, sigCtx)
  const unsignedText = buildForwardText({ note, message: source })
  const outboundText = richSig
    ? appendSignature(unsignedText, richSig.text)
    : buildForwardText({ note: appendSignature(note, user.email_signature), message: source })
  const subject = forwardSubject(source.subject || ticket.subject)

  // No threading headers, deliberately. In-Reply-To pointing at the member's
  // Message-ID would file our forward inside a thread the recipient has never
  // seen. Their reply still comes back to this ticket: Reply-To is the mailbox,
  // and Postmark's outbound RFC Message-ID embeds the API MessageID stored on
  // the row below, which is what the inbound webhook threads on.
  const send = await sendTicketEmail({
    mailboxAddress: mailbox?.address || null,
    // MAILBOX-CONNECT.7 — see the compose route.
    mailbox: mailbox || null,
    to: wire.to,
    cc: wire.cc,
    bcc: wire.bcc,
    subject,
    htmlBody: richSig ? textToHtml(unsignedText) + richSig.html : textToHtml(outboundText),
    textBody: outboundText,
    tag: 'ticket-forward',
    metadata: { ticket_id: ticket.id, contact_id: ticket.contact_id || '' },
    // undefined when nothing rides along, so a bare forward's Postmark payload
    // is byte-identical to a reply's.
    attachments: collected.postmark,
  })
  if (!send.ok) {
    // 503 for an unconfigured ticketing server, 400 for a Postmark refusal.
    // Both write nothing at all.
    return NextResponse.json(
      { success: false, error: send.error },
      { status: send.reason === 'not_configured' ? 503 : 400 },
    )
  }

  const now = new Date().toISOString()

  const { data: message, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticket.id,
    contact_id: ticket.contact_id || null,
    location_id: ticket.location_id,
    direction: 'outbound',
    author_profile_id: user.id,
    from_email: send.fromEmail || null,
    to_email: recipients.to[0],
    to_emails: recipients.to,
    cc_emails: recipients.cc,
    // Stored for the staff thread and for audit, exactly as on a reply. Read
    // back as a recipient by nothing — including this route on a later forward.
    bcc_emails: recipients.bcc,
    subject,
    text_body: outboundText,
    postmark_message_id: send.result.messageId,
    // MAILBOX-CONNECT.7 — the threading key on the SMTP path; see the compose
    // route for the full reasoning. An SMTP send carries no Postmark id, so
    // without this a recipient's reply forks a new ticket. NULL on the Postmark
    // path, which is today's behaviour.
    rfc_message_id: send.result.rfcMessageId || null,
    // mig 501 — WHAT was passed on. The thread renders the marker off this
    // rather than off the "Fwd: " prefix, which is editable text.
    forwarded_message_id: source.id,
    is_internal_note: false,
    source: 'operator',
    status: 'sent',
    sent_at: now,
  }).select('*').single()
  if (msgErr) {
    // The email HAS gone. Say so plainly rather than returning a bare 500 an
    // operator would read as "it failed, send it again" — and record the
    // delivered send, because the row that failed to write was the only thing
    // that would ever have referenced it (EMAIL-COMPOSE-UNFILED.1, same
    // contract as reply and compose). deadLetterWebhook never throws; the
    // provider is deliberately NOT a REPLAYABLE_PROVIDERS key — a replay of a
    // send that already happened would BE the double-send.
    console.error('[tickets/forward] message insert failed AFTER a successful send:', msgErr.message)
    await deadLetterWebhook(db, {
      provider: 'email_ticket_forward',
      eventType: 'sent_not_filed',
      payload: {
        ticket_id: ticket.id,
        // WHAT was passed on — the one fact a forward adds over a reply, and
        // the SENT text (note + quoted correspondence) a third party now has.
        forwarded_message_id: source.id,
        postmark_message_id: send.result.messageId,
        // MAILBOX-CONNECT.7 — the re-fileable record needs the threading key;
        // on the SMTP path the RFC id is the only one that exists.
        rfc_message_id: send.result.rfcMessageId || null,
        from_email: send.fromEmail || null,
        recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
        subject,
        text_body: outboundText,
        author_profile_id: user.id,
        sent_at: now,
      },
      error: msgErr,
      locationId: ticket.location_id,
    })
    return NextResponse.json({
      success: false,
      error: 'The forward was sent but could not be filed on the ticket. Do not resend — check with the recipient before trying again.',
      data: { sent: true, message_id: send.result.messageId },
    }, { status: 500 })
  }

  // The files are already with the recipient; these rows are the studio's own
  // record, pointing at the ORIGINAL'S bytes (mig 501's forwarded_from_id).
  // Never throws, never fails the response.
  await fileForwardedAttachments(db, {
    files: collected.files,
    messageId: message.id,
    locationId: ticket.location_id,
    mailboxId: ticket.mailbox_id || null,
  })

  // ── Attribution ───────────────────────────────────────────────────
  // EVERY address on a forward was typed by a person — nobody put these people
  // on the thread — so the whole set is logged, like a composed email rather
  // than like a reply. A forward is the one action on this surface that takes
  // correspondence a member sent us and sends it somewhere they never named,
  // which is precisely why it carries the sender's name and the time.
  // logAuditEvent never throws; the mail has gone either way.
  await logAuditEvent({
    category: 'business',
    action: 'email_ticket.forwarded',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `email_ticket/${ticket.id}`, label: subject },
    locationId: ticket.location_id,
    details: {
      added: newRecipients(recipients, []),
      recipient_count: recipients.count,
      forwarded_message_id: source.id,
      attachment_count: collected.files.length,
    },
    request,
  })

  // THE TICKET IS NOT UPDATED — see the header. A forward is not an answer to
  // the member, and stamping an outbound last message here would drop the
  // ticket out of the needs-reply queue while they are still waiting.
  return NextResponse.json({
    success: true,
    data: {
      message,
      message_id: send.result.messageId,
      // What actually went out. `bcc` is here for the same reason the reply
      // route returns it: the caller is staff on this ticket, and it travels no
      // further than this response.
      recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
      forwarded_message_id: source.id,
      attachment_count: collected.files.length,
    },
  })
}
