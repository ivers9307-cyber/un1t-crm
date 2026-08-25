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
  replyMode,
  newRecipients,
} from '@/lib/email-recipients'
import {
  collectOutboundAttachments,
  fileOutboundAttachments,
  outboundAttachmentsField,
} from '@/lib/email-outbound-attachments-server'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { withSendMarker } from '@/lib/postmark-send-marker'
import {
  loadTicketForUser, loadOwnAddresses, statusTimestamps,
  loadParticipantMessages, resolveReplyAudience, ticketMergedAway,
} from '../../_helpers'

// EMAIL-CC.1 — an ADDITIONAL address list, on top of the thread's own
// participants. Bounded at parse time so a 10,000-element array is refused
// before any of it is normalised; resolveRecipients then enforces the real cap
// across all three lists combined.
const extraRecipients = z.array(z.string().trim().toLowerCase().pipe(emailAddress))
  .max(MAX_RECIPIENTS)
  .optional()
  .default([])

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
  // EMAIL-OUTBOUND-ATTACH.1 — references to files the browser already uploaded
  // straight to Storage. NEVER the bytes: Vercel 413s a body over ~4.5 MB
  // before this handler runs. See src/lib/email-outbound-attachments-server.js.
  attachments: outboundAttachmentsField,
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
// They are the same code path. The set is `resolveReplyAudience()` over
// `loadParticipantMessages()` — the From + To + Cc of every non-note, non-
// forward message on the ticket, unioned, minus our own addresses and minus
// anyone the operator removed; whether that comes back as one person or four
// is what makes it a reply or a reply-all, and the UI's button says which
// ("Reply All (4 people)").
//
// EMAIL-PARTICIPANTS.5 — IT IS THE WHOLE THREAD, NOT THE LATEST MESSAGE. This
// route used to derive the set from the newest non-note message alone, which
// let whoever wrote last silently redefine who the conversation was with. On
// 2026-08-12 a shared council mailbox opened a thread, a named officer in that
// office answered from her own address, and the reply that followed reached her
// alone — the mailbox that had asked the question never got the answer, and
// nothing on screen said a recipient had been dropped. A conversation
// accumulates people, so the audience accumulates with it. Someone genuinely
// finished with a thread is taken off it deliberately, through
// excluded_participants (mig 534), which is a visible act with an undo — not by
// a derivation rule nobody can see.
//
// bcc_emails IS NOT PART OF "EVERYBODY ON THE THREAD", under any reading.
// ticketParticipants() does not name the column, and PARTICIPANT_COLUMNS does
// not select it. A ticket whose last outbound carried a Bcc reply-alls to
// exactly the people it would have reached had that Bcc never been typed. That
// is the confidentiality guarantee the whole feature exists to keep, and
// email-recipients.test.js mutation-checks it.
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
  const {
    text, internal,
    to: extraTo, cc: extraCc, bcc: extraBcc,
    attachments: drafts,
  } = validation.data

  // An internal note is sent to nobody, so there is nothing for a file to ride
  // on and nothing that would make a stored copy honest. Refused rather than
  // ignored: silently dropping them would leave the operator believing the
  // files are on the ticket, and leave their draft objects with nothing to
  // consume them. (The composer hides the picker in note mode; this is the
  // belt.)
  if (internal && Array.isArray(drafts) && drafts.length > 0) {
    return NextResponse.json({
      success: false,
      error: 'An internal note is not sent to anyone, so it cannot carry files. Remove them, or switch to Reply.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  // EMAIL-MERGE.6 — nothing leaves a tombstone. BEFORE the send, and before
  // the note branch below it: this route sends first and writes second, so
  // refusing here costs a retry and can never produce a half-done outcome.
  //
  // It covers the INTERNAL NOTE path too, deliberately. A note puts no mail on
  // the wire, so it is not the dangerous case — but it would be written onto a
  // ticket hidden from every queue and count, which is an operator typing up
  // what they found and losing it silently. The composer is gone on the web
  // either way; this is for the callers that never had one.
  if (ticket.merged_into_id) return ticketMergedAway(ticket)

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
  // "everybody on the thread" is a property of EVERY message in EITHER
  // direction — otherwise a ticket we composed and nobody has answered yet has
  // no participants at all and reply-all silently degrades to the requester.
  //
  // EMAIL-PARTICIPANTS.5 — the recipient half is now loadParticipantMessages(),
  // the SAME window and the SAME columns the detail route derives its
  // "Reply All (N)" label from. Two windows would be two answers to "who does
  // this reach", and the one the operator can see would not be the one that
  // sends. `bcc_emails` is still not among the columns it asks for.
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
    loadParticipantMessages(db, ticket.id),
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
  const own = await loadOwnAddresses(db)
  if (own.response) return own.response

  // ── Who this reaches (EMAIL-PARTICIPANTS.5) ───────────────────────
  // The union across the whole thread, minus our own addresses and minus
  // anyone the operator removed. A ticket with no usable correspondence (every
  // message an internal note, or a backfilled row with no addresses on it)
  // still falls back to its requester — inside resolveReplyAudience, where the
  // removals apply to the fallback too.
  const audience = resolveReplyAudience({
    messages: recentMessages || [],
    ticket,
    ownAddresses: own.addresses,
  })
  // NOTHING HAS BEEN SENT YET, so both refusals are free — and both exist
  // because the alternative is a send that silently reaches the wrong set.
  if (audience.empty) {
    return NextResponse.json({
      success: false,
      error: 'This ticket has no recipients left — restore one to reply.',
    }, { status: 400 })
  }
  if (audience.over_cap) {
    return NextResponse.json({
      success: false,
      error: `This thread has ${audience.to.length} recipients and the limit is ${MAX_RECIPIENTS}. Remove some before replying.`,
    }, { status: 400 })
  }
  const derivedTo = audience.to

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

  // EMAIL-OUTBOUND-ATTACH.1 — read the draft objects back out of Storage and
  // turn them into Postmark's array. BEFORE THE SEND, deliberately: every way
  // an attachment can be refused (unreadable draft, past Postmark's ceiling, a
  // duplicate slot) has to be a refusal to send AT ALL, or the thread would end
  // up showing a reply that claims files the member never received. Nothing has
  // been written or sent at this point, so a 400 here costs a retry and can
  // produce no wrong outcome.
  const collected = await collectOutboundAttachments(db, { drafts, profileId: user.id })
  if (!collected.ok) {
    return NextResponse.json({ success: false, error: collected.error }, { status: 400 })
  }

  // WHO it reaches, WHAT rides along, and HOW it leaves — three decisions,
  // three seams, one call.
  //
  // EMAIL-CC.1 owns WHO: `wire` is toPostmarkFields() of the resolved set, the
  // single site where a recipient set becomes wire values. All three lists are
  // handed over as-is; `bcc` reaches Postmark's own Bcc field and nothing else,
  // and `headers` carries threading anchors only.
  //
  // EMAIL-OUTBOUND-ATTACH.1 owns WHAT rides along: `collected.postmark` was
  // built above, before anything could be sent, so every refusal already
  // happened.
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
    // POSTMARK-RACE.1 — marked iff `sendLogRow` will be built (same
    // `ticket.contact_id` condition); an unattributed reply stays unmarked.
    metadata: ticket.contact_id
      ? withSendMarker({ ticket_id: ticket.id, contact_id: ticket.contact_id })
      : { ticket_id: ticket.id, contact_id: '' },
    headers,
    // undefined when there are none, so the Postmark payload is byte-identical
    // to every reply this route has ever sent.
    attachments: collected.postmark,
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

  // ── The record of the send — built HERE, not after the filing insert ──
  // From this line on the reply is with the member, so everything below is
  // bookkeeping about a send that already happened. All three pieces are
  // constructed before the message insert so the filing-failure branch below
  // can write the same record the happy path would have (EMAIL-REPLY-UNFILED.1).
  //
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

  // The email_sends row — the contact's email history, delivery-webhook
  // correlation, and how a later reply from the member matches back to this
  // contact via postmark_message_id. contact_id is NOT NULL there, so an
  // unlinked requester gets no row (null here) — the message row is still the
  // operator-facing record.
  //
  // EMAIL-CC.1 — ONE row, for the ticket's own contact, whatever the reply's
  // recipient count. email_sends is the per-contact email history; a Cc'd
  // colleague is not this ticket's contact and inventing rows for them would
  // put mail in strangers' histories and skew every campaign metric that
  // reads the table. to_email logs the primary recipient, matching the
  // message row.
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
  const sendLogRow = ticket.contact_id ? {
    contact_id: ticket.contact_id,
    location_id: ticket.location_id,
    source_type: 'inbox_reply',
    subject,
    from_email: send.fromEmail,
    to_email: recipients.to[0],
    postmark_message_id: result.messageId,
    postmark_stream: TICKET_INTERNAL_STREAM,
    status: 'sent',
  } : null

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
  if (msgErr) {
    // THE MEMBER ALREADY HAS THIS REPLY — Postmark accepted it above. The raw
    // DB error this used to return read as "the send failed, try again", and
    // that retry is a real second email in a real inbox. Same case, same
    // answer as the compose route (EMAIL-REPLY-UNFILED.1): record the
    // delivered send everywhere that can still take it, then say DO NOT
    // RESEND, with `data.sent` so the composer can tell this 500 from every
    // other without string-matching the copy.
    console.error('[tickets/reply] message insert failed AFTER a successful send:', msgErr.message)
    try {
      // The full record — recipients, signed body, threading anchor — because
      // the message row that should have been its record does not exist; this
      // is what a human re-files from. Location-stamped so integration health
      // counts it. The provider is deliberately NOT a REPLAYABLE_PROVIDERS key:
      // a replay of a send that already happened would BE the double-send.
      await deadLetterWebhook(db, {
        provider: 'email_ticket_reply',
        eventType: 'sent_not_filed',
        payload: {
          ticket_id: ticket.id,
          postmark_message_id: result.messageId,
          from_email: send.fromEmail || null,
          recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
          subject,
          text_body: outboundText,
          in_reply_to: lastInbound?.rfc_message_id || null,
          author_profile_id: user.id,
          sent_at: now,
        },
        error: msgErr,
        locationId: ticket.location_id,
      })
      // The halves of the normal path that never needed the message row:
      // the contact's history + delivery-webhook correlation, and the queue
      // moving to pending so it stops saying "needs reply" about a member who
      // has one. Attachment filing is NOT here — its rows hang off message.id.
      if (sendLogRow) await db.from('email_sends').insert(sendLogRow)
      await db.from('email_tickets').update(patch).eq('id', ticket.id)
    } catch (e) {
      // Best-effort by construction: a DB bad enough to fail four writes must
      // still not turn "already sent" back into a retryable-looking error.
      console.error('[tickets/reply] breadcrumbs after the unfiled send also failed:', e?.message)
    }
    return NextResponse.json({
      success: false,
      error: 'The email was sent, but could not be filed on the ticket — the thread will not show it. Do not resend: the member already has it. Add an internal note if the text needs to be on the record.',
      data: { sent: true, message_id: result.messageId },
    }, { status: 500 })
  }

  // EMAIL-OUTBOUND-ATTACH.1 — the files are already with the member; this is
  // only the studio's own copy and the bytes it is billed for. It never throws
  // and never fails the response: answering 500 for mail that genuinely went
  // out would have an operator resend it.
  //
  // Every file becomes a ROW either way — stored, or with a skipped_reason the
  // thread renders in words — so a sent attachment appears in the thread with
  // exactly the same chip, preview and download as a received one.
  await fileOutboundAttachments(db, {
    files: collected.files,
    messageId: message.id,
    locationId: ticket.location_id,
    mailboxId: ticket.mailbox_id || null,
  })

  // Log to email_sends — the row was built above, before the filing insert;
  // see the sendLogRow comment for everything it is and is not.
  if (sendLogRow) {
    await db.from('email_sends').insert(sendLogRow)
  }

  // ── Attribution for anyone the operator ADDED (EMAIL-CC.1) ────────
  // Reply-all reaches people the MEMBER put on the thread and needs no
  // attribution beyond the message row. A hand-typed address is a different
  // act: nobody involved them, so it carries the sender's name at the moment
  // they did it. Fire-and-forget by construction — logAuditEvent never throws
  // and never blocks; the mail has already gone either way.
  //
  // `known` is the derived audience plus the requester. Since
  // EMAIL-PARTICIPANTS.5 that audience is the WHOLE thread, so the
  // earlier-participant over-report this used to carry is gone — those people
  // are in `derivedTo` now, and `added` is only ever a genuinely hand-typed
  // address. The requester stays in `known` unconditionally: they opened the
  // ticket, so they were on the thread whatever the audience says today.
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

  // Advance the queue — the patch was built above, before the filing insert.
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
