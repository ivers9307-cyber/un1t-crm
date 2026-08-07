import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendTicketEmail, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { replySubject, buildReplyHeaders, inboundPreview } from '@/lib/email-inbox'
import { shouldStampFirstResponse } from '@/lib/email-tickets'
import { appendSignature } from '@/lib/email-signature'
import { logAuditEvent } from '@/lib/audit'
import { email as emailAddress } from '@/lib/schemas'
import {
  MAX_RECIPIENTS,
  resolveRecipients,
  toPostmarkFields,
  threadParticipants,
  latestCorrespondence,
  replyMode,
  newRecipients,
} from '@/lib/email-recipients'
import { loadTicketForUser, loadOwnAddresses, statusTimestamps } from '../../_helpers'

// EMAIL-CC.1 — an ADDITIONAL address list, on top of the thread's own
// participants. Bounded at parse time so a 10,000-element array is refused
// before any of it is normalised; resolveRecipients then enforces the real cap
// across all three lists combined.
const extraRecipients = z.array(z.string().trim().toLowerCase().pipe(emailAddress))
  .max(MAX_RECIPIENTS)
  .optional()
  .default([])

// How far back the recipient scan reads. Only the LATEST non-note message
// decides who a reply reaches, so one row would nearly always do — but a
// ticket can end in a run of internal notes, and a scan that stopped at the
// first of them would find no correspondence and silently narrow the reply to
// the requester. Ten covers any realistic run of notes and still costs one
// small query. Every .select() caps at 1,000 rows regardless, so the bound is
// stated rather than left implicit.
const RECIPIENT_SCAN_LIMIT = 10

const ReplySchema = z.object({
  text: z.string().trim().min(1).max(10000),
  // An internal note is staff-to-staff on the ticket. It is written to the
  // thread and NOTHING is sent — the member never sees it, so it also never
  // stamps first_response_at and never advances the ticket.
  internal: z.boolean().optional().default(false),
  // EMAIL-CC.1 — people the operator ADDED. The thread's own participants are
  // derived server-side and are not in here; see THE RECIPIENT RULE below.
  to: extraRecipients,
  cc: extraRecipients,
  bcc: extraRecipients,
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
// ── THE RECIPIENT RULE (EMAIL-CC.1, Richard 2026-08-07) ──────────────────
// THE MODE IS DERIVED, NEVER CHOSEN. This route computes who a reply reaches;
// the client cannot pick "reply" over "reply all", because that choice is
// exactly the affordance that lets someone silently drop a participant by
// clicking the wrong button.
//
//   REPLY      — one recipient. A thread with one other participant.
//   REPLY ALL  — everybody on the thread. Anything wider.
//
// They are the same code path. The set is `threadParticipants()` of the LATEST
// NON-NOTE message — its From + To + Cc — minus our own addresses; whether
// that comes back as one person or four is what makes it a reply or a
// reply-all, and the UI's button says which ("Reply All (4 people)"). Only the
// latest message counts: mail clients follow the latest message and so do the
// people in the conversation, so someone a member deliberately dropped from a
// later reply stays dropped. Resurrecting them would re-copy a person the
// member chose to exclude, over their head.
//
// bcc_emails IS NOT PART OF "EVERYBODY ON THE THREAD", under any reading.
// threadParticipants() does not name the column. A ticket whose last outbound
// carried a Bcc reply-alls to exactly the people it would have reached had
// that Bcc never been typed. That is the confidentiality guarantee the whole
// feature exists to keep, and email-recipients.test.js mutation-checks it.
//
// THE PARTICIPANTS ARE ALWAYS INCLUDED. `to`/`cc`/`bcc` in the body ADD
// people; there is no wire format for removing one. Dropping someone from a
// conversation therefore cannot happen by accident, only by starting a fresh
// email to a narrower set — which is a deliberate act with its own button.
//
// ADDING A STRANGER is a different act from replying to someone who wrote to
// us, and is treated as one: reply-all reaches only people the MEMBER put on
// the thread, while a hand-typed Cc/Bcc is capped (MAX_RECIPIENTS across all
// three lists), validated, stored on the message where every colleague can see
// it, and written to audit_events with the sender's name on it. There is
// deliberately no marketing-consent gate — ticket mail is transactional
// (Richard) — and Postmark's own inactive-recipient rejection is the
// deliverability gate, so a second one here would be redundant.
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
  const { text, internal, to: extraTo, cc: extraCc, bcc: extraBcc } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  const now = new Date().toISOString()

  // ── Internal note — write it, send nothing ────────────────────────
  if (internal) {
    // REFUSED, not silently dropped (mig 482: a note "never carries cc/bcc").
    // An operator who typed three addresses and then switched to note mode has
    // to be told the addresses are going nowhere — swallowing them would let
    // them believe those people were copied on something that was never sent
    // to anybody at all.
    if (extraTo.length || extraCc.length || extraBcc.length) {
      return NextResponse.json({
        success: false,
        error: 'An internal note is sent to nobody, so it cannot carry recipients. Remove them, or switch to a reply.',
      }, { status: 400 })
    }
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
  //
  // EMAIL-CC.1 runs a SECOND, separate lookup beside it for the recipient set.
  // Deliberately not merged into one query: threading must keep keying on the
  // last INBOUND message (changing that would change which mail-client thread
  // a reply lands in, and threading is explicitly out of scope), while
  // "everybody on the thread" is a property of the latest message in EITHER
  // direction — otherwise a ticket we composed and nobody has answered yet has
  // no participants at all and reply-all silently degrades to the requester.
  const [
    { data: lastInbound, error: lastInboundErr },
    { data: recentMessages, error: recentErr },
  ] = await Promise.all([
    db.from('email_inbox_messages')
      .select('rfc_message_id, references_header, subject')
      .eq('ticket_id', ticket.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // NOTE the columns: from_email, to_email(s) and cc_emails. `bcc_emails` is
    // NOT SELECTED, so this route could not leak it into a recipient list even
    // if threadParticipants() were changed to look for it.
    db.from('email_inbox_messages')
      .select('from_email, to_email, to_emails, cc_emails, is_internal_note, created_at, sent_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: false })
      .limit(RECIPIENT_SCAN_LIMIT),
  ])
  if (lastInboundErr) {
    console.error('[tickets/reply] threading lookup failed BEFORE sending:', lastInboundErr.message)
    return NextResponse.json({ success: false, error: lastInboundErr.message }, { status: 500 })
  }
  if (recentErr) {
    // Same ordering argument as the threading lookup: nothing has been sent, so
    // refusing costs a retry. Falling back to "just the requester" would look
    // like a successful reply while quietly dropping everyone else on the
    // thread — the exact failure the derived-mode rule exists to prevent.
    console.error('[tickets/reply] recipient lookup failed BEFORE sending:', recentErr.message)
    return NextResponse.json({ success: false, error: recentErr.message }, { status: 500 })
  }

  // Our own addresses, so a reply-all cannot mail the studio and loop back
  // through the inbound webhook onto this same ticket. See loadOwnAddresses.
  const own = await loadOwnAddresses(db, ticket.location_id)
  if (own.response) return own.response

  // ── Who this reaches ──────────────────────────────────────────────
  const latest = latestCorrespondence(recentMessages || [])
  const participants = threadParticipants(latest, { exclude: own.addresses })
  // A ticket with no usable correspondence (every message an internal note, or
  // a backfilled row with no addresses on it) still has a requester.
  const derivedTo = participants.length ? participants : [ticket.requester_email]

  const recipients = resolveRecipients({
    to: [...derivedTo, ...extraTo],
    cc: extraCc,
    bcc: extraBcc,
    exclude: own.addresses,
  })
  if (!recipients.ok) {
    return NextResponse.json({ success: false, error: recipients.error }, { status: 400 })
  }
  const wire = toPostmarkFields(recipients)
  const mode = replyMode(recipients.to)

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

  // WHO it reaches vs HOW it leaves — two decisions, two seams, one call.
  //
  // EMAIL-CC.1 owns WHO: `wire` is toPostmarkFields() of the resolved set, the
  // single site where a recipient set becomes wire values. All three lists are
  // handed over as-is; `bcc` reaches Postmark's own Bcc field and nothing else,
  // and `headers` carries threading anchors only.
  //
  // EMAIL-OUTBOUND-SERVER.1 owns HOW: the reply leaves on the SUPPORT INBOX'S
  // OWN Postmark server, from the ticket's own mailbox address, on Postmark's
  // `email-send` stream. All three live in sendTicketEmail; see that file's
  // header for the topology and for why a Postmark stream id must never be
  // confused with our internal 'outbound'.
  //
  // Reply-To stays the ticket's mailbox so the member's next reply comes back
  // to the address they wrote to and threads onto this ticket. A ticket with no
  // mailbox (an elevated caller answering correspondence whose address was
  // deleted) still sends, from a domain we own.
  const send = await sendTicketEmail({
    mailboxAddress: mailbox?.address || null,
    to: wire.to,
    cc: wire.cc,
    bcc: wire.bcc,
    subject,
    htmlBody: textToHtml(outboundText),
    textBody: outboundText,
    tag: 'ticket-reply',
    metadata: { ticket_id: ticket.id, contact_id: ticket.contact_id || '' },
    headers,
  })
  if (!send.ok) {
    // Send failed → the ticket does NOT advance to pending. A queue that says
    // "waiting on the member" when the member was never written to is the
    // worst possible lie for a support tool to tell.
    //
    // 503 for an unconfigured ticketing server, 400 for a Postmark refusal:
    // the first is ours to fix and retryable unchanged, the second is about
    // this particular message. Both write nothing.
    return NextResponse.json(
      { success: false, error: send.error },
      { status: send.reason === 'not_configured' ? 503 : 400 }
    )
  }
  const result = send.result

  const { data: message, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticket.id,
    contact_id: ticket.contact_id || null,
    location_id: ticket.location_id,
    direction: 'outbound',
    // WHO sent it (mig 493). from_email stays the Postmark From, which is what
    // actually went on the wire — it is not an author field. EMAIL-OUTBOUND
    // -SERVER.1: that is now usually the mailbox's own address, and on the
    // degraded path a domain we own — so it is read back off the send verdict
    // rather than assumed from POSTMARK_FROM_EMAIL, which would be a lie.
    author_profile_id: user.id,
    from_email: send.fromEmail || null,
    // to_email stays the PRIMARY recipient and to_emails carries the rest
    // (mig 499) — the scalar is what email_sends logs and what every reader
    // written before EMAIL-CC.1 understands, so the two are kept consistent
    // rather than one deprecated.
    to_email: recipients.to[0],
    to_emails: recipients.to,
    cc_emails: recipients.cc,
    // Stored for the staff thread and for audit. NOTHING reads this back as a
    // recipient — not this route on the next reply, not the forward that
    // reuses this model. See the RECIPIENT RULE header.
    bcc_emails: recipients.bcc,
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
  //
  // EMAIL-CC.1 — ONE row, for the ticket's own contact, whatever the reply's
  // recipient count. email_sends.contact_id is NOT NULL and the table is the
  // per-contact email history; a Cc'd colleague is not this ticket's contact
  // and inventing rows for them would put mail in strangers' histories and
  // skew every campaign metric that reads the table. to_email logs the primary
  // recipient, matching the message row above.
  //
  // EMAIL-OUTBOUND-SERVER.1 — the row still describes the send correctly now
  // that a DIFFERENT Postmark server sent it. postmark_message_id is an
  // account-wide GUID, so the delivery webhook still correlates on it whichever
  // server the event comes from; from_email records the real From; and
  // postmark_stream is THIS APP'S 'outbound', written from the shared constant,
  // NEVER the Postmark stream id the message actually rode. That column feeds
  // consent classification (consentFieldForStream → email_administrative) and
  // the email-hygiene sweeps' `= 'broadcast'` filters; a provider slug in it
  // would be read as "not marketing" by accident rather than by rule.
  if (ticket.contact_id) {
    await db.from('email_sends').insert({
      contact_id: ticket.contact_id,
      location_id: ticket.location_id,
      source_type: 'inbox_reply',
      subject,
      from_email: send.fromEmail,
      to_email: recipients.to[0],
      postmark_message_id: result.messageId,
      postmark_stream: TICKET_INTERNAL_STREAM,
      status: 'sent',
    })
  }

  // ── Attribution for anyone the operator ADDED (EMAIL-CC.1) ────────
  // Reply-all reaches people the MEMBER put on the thread and needs no
  // attribution beyond the message row. A hand-typed address is a different
  // act: nobody involved them, so it carries the sender's name at the moment
  // they did it. Fire-and-forget by construction — logAuditEvent never throws
  // and never blocks; the mail has already gone either way.
  //
  // `known` is the derived participant set plus the requester, so a person who
  // appeared on an EARLIER message but not the latest is logged as added.
  // That over-reports rather than under-reports, which is the right direction
  // for an audit trail.
  const added = newRecipients(recipients, [...derivedTo, ticket.requester_email])
  if (added.length) {
    await logAuditEvent({
      category: 'business',
      action: 'email_ticket.recipients_added',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { resource: `email_ticket/${ticket.id}`, label: ticket.subject || null },
      locationId: ticket.location_id,
      details: { added, mode, recipient_count: recipients.count },
      request,
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
    data: {
      message,
      status: 'pending',
      message_id: result.messageId,
      // What actually went out, so the surface can confirm it rather than
      // re-deriving it. `bcc` is here because the SENDER is staff on this
      // ticket and seeing their own Bcc list is correct — it is the same
      // audience as the thread itself, and the same audience mig 482's own
      // COMMENT names. It never travels any further than this response.
      recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
      mode,
    },
  })
}
