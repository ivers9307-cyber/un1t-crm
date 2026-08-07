// EMAIL-INBOX.1 / EMAIL-TICKET.3 — Postmark inbound webhook for the
// email channel.
//
// Postmark's inbound stream POSTs every email received on a configured
// inbound address here. Each one becomes a TICKET (email_tickets, mig
// 482) filed against the MAILBOX it was delivered to (email_mailboxes,
// mig 485).
//
// Auth — token-in-URL pattern (same as invoices-inbound): Postmark's
// inbound webhook config only lets you set a URL, not custom headers,
// so the shared secret lives in the path. Configure Postmark to POST
// to https://crm.un1tdublin.com/api/webhooks/postmark-inbound/<token>
// where <token> = POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN. Rotation via
// POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS, then unset PREVIOUS.
// Wrong token 404s (not 403) so the URL pattern can't be probed.
//
// WHERE the mail landed — the recipient address is matched against
// ACTIVE email_mailboxes and the mailbox carries the location. There
// is NO fallback: an unmatched recipient DEAD-LETTERS. The route used
// to default to "the oldest active location", which is how Postmark's
// own sample payload filed itself into Stillorgan's queue on
// 2026-08-05. With several addresses across several domains that
// silently mixes one studio's mail into another's. Consequence, stated
// plainly: with Postmark inbound-domain forwarding EVERY address at a
// configured domain reaches this route, so anything@ that is not a
// configured mailbox now dead-letters. That is correct — it is not a
// mailbox — and webhook_dead_letter is a surface someone can look at,
// unlike a wrong studio's queue. Operators who want everything
// captured configure a catch-all mailbox.
//
// WHO it is from (helpers in src/lib/email-inbox.js):
//   (a) In-Reply-To / References ids matched against
//       email_sends.postmark_message_id → that send's contact (a reply
//       to OUR campaign/sequence mail — the highest-signal path).
//       Contact ONLY: the mailbox is authoritative about location and
//       nothing else may override it.
//   (b) else From address → contacts by email; the pick is
//       deterministic (mailbox location preferred, then oldest
//       created_at). An unknown sender still gets a ticket, with
//       contact_id NULL.
//
// WHICH ticket it joins: threading ids are matched against this
// location's own email_inbox_messages, most recent wins
// (pickThreadedTicket), and resolveTicketAction decides append vs
// create. A reply to a CLOSED ticket REOPENS it — it does not fork
// (Richard, 2026-08-07). Closing is internal bookkeeping; the status
// route sends the member nothing, so replying to their own old email
// is just continuing the conversation, and a fork would make our
// record disagree with the thread in their mail client.
//
// What stops a ticket decaying back into mig 394's immortal
// per-person thread is the THREADING itself, not the closed state: a
// genuinely new enquiry carries no In-Reply-To/References match,
// resolves to no ticket, and starts a fresh one.
//
// NO DUAL-WRITE ANY MORE (EMAIL-CONV-STOP.1, 2026-08-07). This route used
// to maintain a mig 394 email_conversations row beside the ticket and stamp
// BOTH ids onto the message. It now neither reads nor writes that table.
//
// THAT REMOVAL IS THE POINT OF THE CHANGE, not tidying. The conversation
// lookup and the conversation insert each answered 500 on failure, and both
// ran BEFORE the ticket insert — so a fault in a table no surface reads any
// more could lose real mail, permanently and silently:
//
//   conversation query fails → 500 → Postmark retries the same MessageID →
//   recordWebhookEvent already wrote the dedupe row on the first attempt →
//   the retry short-circuits to 200 `deduped` → the email is filed NOWHERE.
//   No ticket, no message, no error, no dead letter. First retry, gone.
//
// That is why this change is CODE-ONLY and ships FIRST: dropping the table
// before this deployed would have fired exactly that chain on the very next
// inbound email, deterministically.
//
// THE ORDERING PROBLEM ITSELF IS NOW FIXED HERE (EMAIL-DEDUPE-RELEASE.1,
// 2026-08-07). The chain was never about email_conversations — it is a
// property of claiming the dedupe row BEFORE the work succeeds, so EVERY 5xx
// in this route was lost the same way on Postmark's retry:
//   thread_lookup_failed (email_sends) · mailbox_lookup_failed
//   (email_mailboxes) · contact_lookup_failed (contacts) ·
//   ticket_lookup_failed (both the email_inbox_messages thread scan and the
//   email_tickets fetch) · ticket_insert_failed · message_insert_failed.
// So the claim is RELEASED on the way out: POST records it, hands the work to
// processInboundEmail(), and DELETEs the webhook_events row again whenever
// that returns >= 500 — or throws, which `new Date(body.Date).toISOString()`
// on a malformed Date header will do on attacker-supplied input. Postmark's
// retry then finds no claim and genuinely re-processes. A 2xx KEEPS the
// claim, so a real re-delivery of an already-processed message still
// short-circuits to 200 `deduped`, exactly as before.
//
// DELIBERATELY LOCAL TO THIS ROUTE. src/lib/webhook-events.js is shared with
// nine other webhooks including three Revolut payment receivers, where
// releasing a claim could process a payment twice — worse than losing one.
// Nothing here touches that helper: the DELETE is written inline and names
// this route's own pair (provider 'postmark', event_id
// `inbound-email:<MessageID>`), so it cannot reach another route's rows.
// The other nine still claim-before-work and still lose an event on a 5xx
// retry; that is a separate, supervised review.
//
// CONCURRENCY, PLAINLY. An attempt releases only AFTER it has stopped writing
// (it releases and returns), so the release never puts two attempts in the
// write phase together. A duplicate that arrives while attempt 1 is still
// running still gets 200 `deduped` and writes nothing — safe only because
// attempt 1's own 500 keeps Postmark's retry chain alive. RESIDUAL WINDOW: if
// that concurrent duplicate IS Postmark's retry and it 200s before attempt 1
// fails, Postmark treats the message as delivered and the mail is still lost.
// The window is this request's own runtime (sub-second) against Postmark's
// minutes-long retry backoff. Closing it needs claim-on-success or a claim
// with a state column — i.e. changing the shared table's semantics, which is
// not being done unattended. The unique index on
// email_inbox_messages.postmark_message_id (23505 → treated as success below)
// makes a genuine double-write of the MESSAGE harmless, but it does not cover
// email_tickets: a 500 from the message insert after the ticket insert
// succeeded now leaves an empty ticket behind, because the retry re-processes
// and opens its own. An orphan ticket someone can see beats mail that
// vanished, so that cost is accepted.
//
// A FAILED RELEASE is logged loudly, dead-lettered (provider
// 'postmark_inbound', error 'dedupe_release_failed') and still answers 500
// with the ORIGINAL error: a client-side error is not proof the DELETE did
// not commit, so a retry may still land, and the payload is captured for
// triage either way.
//
// SECOND ACCEPTED COST: a payload that fails DETERMINISTICALLY (not
// transiently) now 5xxs on every Postmark retry instead of being swallowed as
// `deduped` after the first. It burns that message's retry schedule and shows
// up in Postmark's activity log — which is the point, since the alternative
// is the failure being invisible. The route already answered 500 on attempt
// one either way, so this adds retries of an already-failing message, not a
// new class of non-2xx.
//
// email_inbox_messages.conversation_id still exists as a column and is now
// simply never written (deprecated-columns-stay-on-disk, CLAUDE.md). A
// later migration retires the column, the table, the
// increment_email_conversation_unread RPC and its realtime/RLS entries.
//
// Why no queue table (unlike the outbound Postmark webhook): inbound
// human replies are low-volume (no 5k-in-20s bursts) and each event
// creates rows regardless — deferring would just add a hop. Same
// reasoning as invoices-inbound.
//
// Idempotency: recordWebhookEvent on Postmark's MessageID (released again
// on any 5xx — see above), plus the unique index on
// email_inbox_messages.postmark_message_id as the belt-and-braces layer.
//
// ATTACHMENTS (EMAIL-ATTACH.1, mig 496). Postmark inlines the files as base64
// in `Attachments`; they are re-hosted into the private email-attachments
// bucket and metered against the delivering mailbox's 5 GB quota. The whole
// step is subordinate to filing the message: it runs after the message insert,
// answers nothing, and records a row with a skipped_reason for any file it
// could not keep. See src/lib/email-attachments-server.js.
//
// ⚠️ THE REAL CEILING IS VERCEL'S REQUEST-BODY CAP, NOT OUR SIZE CHECK.
// Nothing in this route, next.config.mjs or vercel.json limits the body — App
// Router route handlers have no bodyParser.sizeLimit (that was Pages Router)
// and `await request.json()` reads whatever arrives. What DOES cap it is the
// platform: a Vercel Node function rejects a request body over ~4.5 MB with a
// 413 before this handler is ever invoked (the same cap that forced
// direct-to-storage uploads in WA-PIPELINE #450 and the contractor-invoice
// path #453). Because Postmark base64-encodes inline attachments (~4/3
// expansion), that puts the practical inbound ceiling at roughly 3.3 MB of
// attachment bytes per EMAIL — well under Postmark's own 25 MB inbound limit
// and under our per-file MAX_ATTACHMENT_BYTES. A larger mail therefore does
// not reach the `too_large` branch at all: Postmark sees a 413, retries, and
// the message is never filed. That is a pre-existing property of every inbound
// email on this route (bodies too), not something attachments introduced, and
// fixing it needs Postmark's inbound "strip attachments + fetch by URL" mode
// rather than a code change here. Flagged rather than papered over.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { htmlToPlainText } from '@/lib/email-content'
import {
  normalizeEmail,
  getHeader,
  extractCandidateMessageIds,
  extractRfcMessageId,
  recipientEmails,
  pickContact,
  inboundPreview,
  truncateHtmlBody,
} from '@/lib/email-inbox'
import { resolveMailboxByRecipient } from '@/lib/email-mailboxes'
import { resolveTicketAction, ticketSubject, pickThreadedTicket } from '@/lib/email-tickets'
import { escapeLikePattern } from '@/lib/like-escape'
import { storeInboundAttachments } from '@/lib/email-attachments-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Token-in-URL auth — timing-safe compare against the primary and the
 * optional rotation token. Exported for the guard's benefit and so a
 * route test can exercise the gate without a request fixture. Mirrors
 * verifyInboundRequest in the invoices-inbound webhook.
 */
export function verifyEmailInboundRequest({ urlToken, primarySecret, previousSecret }) {
  if (!primarySecret) return { ok: false, status: 500, reason: 'missing_secret' }
  if (!urlToken) return { ok: false, status: 404, reason: 'missing_token' }
  const primary = verifySharedSecret(urlToken, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }
  if (previousSecret) {
    const previous = verifySharedSecret(urlToken, previousSecret)
    if (previous.ok) return { ok: true, matched: 'previous' }
  }
  return { ok: false, status: 404, reason: 'token_mismatch' }
}

// Chunk .in() candidate lists defensively (header chains can be long).
const MAX_THREAD_CANDIDATES = 40

/** The dedupe key this route claims. One place, so the DELETE can't drift. */
const dedupeEventId = (messageId) => `inbound-email:${messageId}`

/**
 * Give back the dedupe claim so Postmark's retry re-processes the message
 * instead of short-circuiting to 200 `deduped` and losing it.
 *
 * Written inline rather than added to src/lib/webhook-events.js on purpose:
 * that helper is shared with nine other webhooks (three of them Revolut
 * payment receivers) where releasing a claim risks a double payment. This
 * DELETE names one (provider, event_id) pair — this route's own — so it
 * cannot affect any other webhook.
 *
 * Failure-tolerant: supabase-js builders are thenables with NO `.catch`
 * (a `.catch()` here would throw, not catch), hence try/catch. Returns
 * whether the claim is provably gone, so the caller can escalate.
 *
 * @returns {Promise<boolean>}
 */
async function releaseDedupeClaim(db, eventId) {
  try {
    const { error } = await db.from('webhook_events')
      .delete()
      .eq('provider', WEBHOOK_PROVIDERS.POSTMARK)
      .eq('event_id', eventId)
    if (error) {
      console.error(
        '[postmark-inbound] DEDUPE RELEASE FAILED — Postmark will retry this ' +
        'MessageID and the retry will short-circuit as `deduped`, losing the ' +
        `email. event_id=${eventId}:`, error.message,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(
      '[postmark-inbound] DEDUPE RELEASE THREW — the retry will short-circuit ' +
      `as \`deduped\` and the email will be lost. event_id=${eventId}:`,
      err?.message,
    )
    return false
  }
}

export async function POST(request, { params }) {
  const { token } = await params
  const auth = verifyEmailInboundRequest({
    urlToken: token,
    primarySecret: process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN,
    previousSecret: process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error('[security] POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN not set — refusing inbound email webhook.')
    } else {
      console.warn(`[security] Inbound email webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    console.warn(
      '[security] Inbound email webhook accepted via POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating the Postmark inbound URL to the new token, then unset PREVIOUS.'
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const messageId = body?.MessageID
  if (!messageId) {
    return NextResponse.json({ success: false, error: 'Missing MessageID' }, { status: 400 })
  }

  const db = createServerClient()

  // Idempotency — Postmark retries on 5xx; don't double-thread.
  const eventId = dedupeEventId(messageId)
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK, eventId,
  })
  if (dedup.seen) {
    // A genuine re-delivery of a message a previous attempt processed to a
    // 2xx. Unchanged: short-circuit, write nothing.
    return NextResponse.json({ success: true, deduped: true })
  }

  // ── From here the claim is HELD ───────────────────────────────────
  // Single exit point so no 5xx can escape still holding it. NOT a plain
  // try/finally: a finally would also release on success, which would undo
  // dedupe entirely and let a real re-delivery be processed twice. And not
  // per-return-site either — that misses the throws (a malformed `Date`
  // header makes `new Date(...).toISOString()` raise, and Next would answer
  // 500 with the claim still held). Status-gated release + a catch-all
  // covers both, and every non-5xx response passes through untouched.
  let res
  try {
    res = await processInboundEmail(db, body, messageId)
  } catch (err) {
    console.error('[postmark-inbound] unhandled error:', err?.message)
    res = NextResponse.json({ success: false, error: 'unhandled_error' }, { status: 500 })
  }

  if (res.status >= 500) {
    // Released unconditionally. `dedup.error` (the insert reported a failure)
    // is NOT proof the row failed to commit, and a DELETE matching nothing
    // costs one round trip on a path that is already failing.
    const released = await releaseDedupeClaim(db, eventId)
    if (!released) {
      // We know the retry will now be swallowed as `deduped`, so capture the
      // payload somewhere an operator can see it. deadLetterWebhook never
      // throws and never blocks. provider 'postmark_inbound', NOT
      // WEBHOOK_PROVIDERS.POSTMARK — same reason as the no_matching_mailbox
      // dead-letter below: that key is auto-replayable into the OUTBOUND
      // queue, which is the wrong pipeline for an inbound email.
      await deadLetterWebhook(db, {
        provider: 'postmark_inbound',
        eventType: 'inbound_email',
        payload: body,
        error: 'dedupe_release_failed',
      })
    }
    // Still 500, with the ORIGINAL error untouched: the failure is real, a
    // 200 would tell Postmark to stop retrying, and a client-side error on
    // the DELETE does not prove it failed to commit — the retry may yet land.
  }

  return res
}

/**
 * The actual work. Split out of POST ONLY so there is one place to release
 * the dedupe claim on the way out; every `return` below is the response POST
 * answers with, unchanged.
 */
async function processInboundEmail(db, body, messageId) {
  const fromEmail = normalizeEmail(body.FromFull?.Email || body.From)
  if (!fromEmail) {
    // A real email always has a sender; without one there is nothing to
    // thread. 200 so Postmark doesn't retry an unfixable payload.
    console.warn('[postmark-inbound] no parseable From address', { messageId })
    return NextResponse.json({ success: true, ignored: 'no_sender' })
  }

  // ── Threading resolution ──────────────────────────────────────────
  const headers = Array.isArray(body.Headers) ? body.Headers : []
  const recipients = recipientEmails(body)
  let contactId = null
  let matchedVia = 'unmatched'

  // (a) Reply to one of OUR sends — In-Reply-To/References ↔ email_sends.
  // Resolves CONTACT only. It used to resolve location too; since the
  // mailbox cutover the delivered-to address is the only thing that says
  // where mail landed, and a threading header is attacker-controlled.
  const candidates = extractCandidateMessageIds(headers).slice(0, MAX_THREAD_CANDIDATES)
  if (candidates.length) {
    const { data: sends, error: sendsErr } = await db.from('email_sends')
      .select('contact_id, postmark_message_id, sent_at')
      .in('postmark_message_id', candidates)
      .order('sent_at', { ascending: false })
      .limit(1)
    if (sendsErr) {
      console.error('[postmark-inbound] email_sends lookup failed:', sendsErr.message)
      return NextResponse.json({ success: false, error: 'thread_lookup_failed' }, { status: 500 })
    }
    const send = sends?.[0]
    if (send) {
      contactId = send.contact_id || null
      matchedVia = 'in_reply_to'
    }
  }

  // Recipient address → mailbox → location. AUTHORITATIVE, and the only
  // thing that decides where this mail is filed. Small table — match in JS
  // (resolveMailboxByRecipient also enforces the recipient precedence order,
  // so a message addressed to two of our mailboxes resolves the same way
  // regardless of what order the rows came back in).
  const { data: mailboxes, error: mbErr } = await db.from('email_mailboxes')
    .select('id, location_id, address, active')
    .eq('active', true)
  if (mbErr) {
    console.error('[postmark-inbound] email_mailboxes lookup failed:', mbErr.message)
    return NextResponse.json({ success: false, error: 'mailbox_lookup_failed' }, { status: 500 })
  }
  const mailbox = resolveMailboxByRecipient(mailboxes || [], recipients)
  if (!mailbox) {
    // No fallback, by design — see the header. 200 because retrying will not
    // conjure a mailbox and a non-2xx makes Postmark disable the webhook.
    //
    // provider is 'postmark_inbound', NOT WEBHOOK_PROVIDERS.POSTMARK: that
    // key is registered auto-replayable and its re-driver re-inserts the
    // payload into postmark_webhook_queue — the OUTBOUND delivery-event
    // queue. Replaying an inbound email through it would push an email into
    // the wrong pipeline AND mark the dead-letter row resolved when nothing
    // was. This failure is not replayable: it needs an operator to configure
    // a mailbox, so the row stays pending and visible for triage.
    await deadLetterWebhook(db, {
      provider: 'postmark_inbound',
      eventType: 'inbound_email',
      payload: body,
      error: 'no_matching_mailbox',
    })
    console.warn('[postmark-inbound] no active mailbox matched — dead-lettered', {
      messageId, recipients,
    })
    return NextResponse.json({ success: true, dead_lettered: 'no_matching_mailbox' })
  }
  const locationId = mailbox.location_id

  // (b) From address → contacts (deterministic pick; prefer the mailbox's
  // location). Runs even when (a) matched but the send had no contact — and
  // fills contact linkage for recipient-only matches.
  if (!contactId) {
    // escapeLikePattern: fromEmail comes off an UNAUTHENTICATED webhook and
    // normalizeEmail admits both LIKE wildcards, so a bare .ilike() matched a
    // PATTERN — `%@example.com` picked up every contact at the domain and
    // `a_b@` also matched `axb@`. pickContact then chose one deterministically,
    // linking a stranger's mail to a real contact's identity, silently.
    const { data: contacts, error: cErr } = await db.from('contacts')
      .select('id, location_id, created_at')
      .ilike('email', escapeLikePattern(fromEmail))
      .limit(50)
    if (cErr) {
      console.error('[postmark-inbound] contacts lookup failed:', cErr.message)
      return NextResponse.json({ success: false, error: 'contact_lookup_failed' }, { status: 500 })
    }
    const picked = pickContact(contacts || [], locationId)
    if (picked) {
      contactId = picked.id
      if (matchedVia === 'unmatched') matchedVia = 'from_address'
    }
  }

  // Stamped last, so matched_via still reports the strongest signal we had:
  // 'recipient_address' now means "the mailbox matched but we could not
  // identify the sender", which is the diagnostic worth having.
  if (matchedVia === 'unmatched') matchedVia = 'recipient_address'

  // ── Which ticket does this join? ──────────────────────────────────
  // Our own earlier messages in this location whose ids a threading header
  // names. Location-scoped: an RFC id is guessable text in an attacker-
  // supplied header, and without the scope a crafted In-Reply-To could
  // thread a stranger's mail into another studio's ticket — the very
  // cross-studio mixing the mailbox routing exists to prevent.
  //
  // Two `.in()` queries rather than one `.or()`: `.or()` takes a RAW
  // PostgREST filter string, so a stray `)` in a References header would
  // rewrite the filter. `.in()` is escaped by postgrest-js.
  let threadedTicket = null
  if (candidates.length) {
    const [byRfc, byPostmark] = await Promise.all([
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('rfc_message_id', candidates),
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('postmark_message_id', candidates),
    ])
    const threadErr = byRfc.error || byPostmark.error
    if (threadErr) {
      console.error('[postmark-inbound] ticket thread lookup failed:', threadErr.message)
      return NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 })
    }
    const threadedTicketId = pickThreadedTicket([...(byRfc.data || []), ...(byPostmark.data || [])])
    if (threadedTicketId) {
      const { data: found, error: tErr } = await db.from('email_tickets')
        .select('id, status, subject, first_response_at')
        .eq('id', threadedTicketId)
        .eq('location_id', locationId)
        .maybeSingle()
      if (tErr) {
        console.error('[postmark-inbound] ticket lookup failed:', tErr.message)
        return NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 })
      }
      threadedTicket = found || null
    }
  }
  const action = resolveTicketAction(threadedTicket)

  const subject = body.Subject || null
  const counterpartName = body.FromFull?.Name || null
  const textBody = (body.TextBody || '').trim() || htmlToPlainText(body.HtmlBody) || ''
  const now = new Date().toISOString()
  const preview = inboundPreview(textBody) || (subject ? inboundPreview(subject) : '')

  // ── Create or append the ticket ───────────────────────────────────
  // `append` writes nothing yet — its summary update runs after the message
  // lands, so a failed message insert can't leave a ticket claiming activity
  // that isn't in the thread. `create` has to insert first:
  // email_inbox_messages.ticket_id is a foreign key.
  let ticketId = null
  if (action.action === 'append') {
    ticketId = action.ticketId
  } else {
    const { data: createdTicket, error: ticketErr } = await db.from('email_tickets')
      .insert({
        location_id: locationId,
        mailbox_id: mailbox.id,
        contact_id: contactId,
        requester_email: fromEmail,
        requester_name: counterpartName,
        subject: ticketSubject(null, subject),
        status: 'open',
        // Set only when this reply threaded to a CLOSED ticket. That ticket
        // stays closed — this is its successor, not its resurrection.
        reopened_from: action.reopenedFrom,
        last_message_at: now,
        last_message_direction: 'inbound',
        last_message_preview: preview,
      })
      .select('id')
      .single()
    if (ticketErr || !createdTicket) {
      console.error('[postmark-inbound] ticket insert failed:', ticketErr?.message)
      return NextResponse.json({ success: false, error: 'ticket_insert_failed' }, { status: 500 })
    }
    ticketId = createdTicket.id
  }

  // ── Insert the message ────────────────────────────────────────────
  // ticket_id ONLY. conversation_id is left NULL — the column survives this
  // change (a later migration drops it) but nothing writes it any more.
  //
  // `.select('id')` since EMAIL-ATTACH.1: email_ticket_attachments.message_id
  // is a foreign key, so the attachments cannot be written without the row's
  // own id. It changes nothing about the insert itself — 23505 on the unique
  // postmark_message_id index still arrives as an error with the same code.
  const { data: insertedMessage, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticketId,
    contact_id: contactId,
    location_id: locationId,
    direction: 'inbound',
    from_email: fromEmail,
    to_email: recipients[0] || null,
    subject,
    text_body: textBody,
    html_body: truncateHtmlBody(body.HtmlBody || null),
    postmark_message_id: messageId,
    rfc_message_id: extractRfcMessageId(headers),
    in_reply_to: getHeader(headers, 'In-Reply-To'),
    references_header: getHeader(headers, 'References'),
    status: 'received',
    sent_at: body.Date ? new Date(body.Date).toISOString() : now,
  })
    .select('id')
    .single()
  if (msgErr) {
    // 23505 = the unique postmark_message_id index caught a racing
    // duplicate — that's a success, not an error.
    if (msgErr.code === '23505') {
      return NextResponse.json({ success: true, deduped: true })
    }
    console.error('[postmark-inbound] message insert failed:', msgErr.message)
    return NextResponse.json({ success: false, error: 'message_insert_failed' }, { status: 500 })
  }

  // ── Attachments (EMAIL-ATTACH.1) ──────────────────────────────────
  // AFTER the message row exists (they FK to it) and BEFORE nothing: this call
  // can never fail the email. storeInboundAttachments() catches everything it
  // does, records a row with a skipped_reason for each file it could not keep,
  // and returns a summary — there is no error here for this route to answer
  // with, and there must not be. An oversized invoice, a full mailbox or a
  // Storage outage must all still leave the member's message filed and
  // readable, exactly as they would if the mail carried no attachment at all.
  //
  // The try/catch is belt-and-braces on a function that already swallows its
  // own faults, because the cost of being wrong here is losing an email.
  //
  // Metered against THIS mailbox — the one the mail was actually delivered to,
  // which is also the only mailbox that could possibly be involved on the
  // inbound path (an unmatched recipient dead-letters long before this line).
  if (Array.isArray(body.Attachments) && body.Attachments.length > 0 && insertedMessage?.id) {
    try {
      const stored = await storeInboundAttachments(db, {
        attachments: body.Attachments,
        messageId: insertedMessage.id,
        locationId,
        mailboxId: mailbox.id,
      })
      if (stored.skipped > 0) {
        console.warn('[postmark-inbound] attachments not stored', {
          messageId, ticketId, ...stored.reasons,
        })
      }
    } catch (err) {
      console.error('[postmark-inbound] attachment storage threw (email still filed):', err?.message)
    }
  }

  // ── Bump the ticket ───────────────────────────────────────────────
  // No `subject` here on purpose: a ticket is named by the issue that opened
  // it. Mig 394 tracked the latest inbound and thread names drifted with
  // every "Re: Re: Fwd:".
  if (action.action === 'append') {
    await db.from('email_tickets').update({
      status: 'open',
      last_message_at: now,
      last_message_direction: 'inbound',
      last_message_preview: preview,
      updated_at: now,
    }).eq('id', ticketId)
  }
  // supabase-js builders are thenables with no .catch — try/catch, not
  // .catch(), or the rpc never fires.
  try { await db.rpc('increment_email_ticket_unread', { p_ticket_id: ticketId }) } catch {}

  return NextResponse.json({
    success: true,
    ticket_id: ticketId,
    mailbox_id: mailbox.id,
    matched_via: matchedVia,
  })
}
