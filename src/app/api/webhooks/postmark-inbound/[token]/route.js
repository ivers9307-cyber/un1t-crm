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
// WHO it is from (helpers in src/lib/email-inbox.js): the From address
// → contacts by email, and nothing else. The pick is deterministic
// (mailbox location preferred, then oldest created_at). An unknown
// sender still gets a ticket, with contact_id NULL.
//
// In-Reply-To / References ids are still matched against
// email_sends.postmark_message_id, but ONLY to report matched_via
// 'in_reply_to'. They used to hand over that send's contact as well —
// which meant a header the SENDER writes decided whose record an email
// landed on, before we ever read the From address. Forward one of our
// emails to a friend, have them reply, and their correspondence is
// filed onto the member's timeline and into the member's DSAR export.
// EMAIL-PARTICIPANTS.10 cut that link: threading and identity are
// separate questions, and an unlinked message is honest where a
// wrongly-linked one is a data-integrity breach.
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
// ⚠️ VERCEL'S REQUEST-BODY CAP, AND THE SHIM THAT NOW FRONTS THIS ROUTE.
// Nothing in this route, next.config.mjs or vercel.json limits the body — App
// Router route handlers have no bodyParser.sizeLimit (that was Pages Router)
// and `await request.json()` reads whatever arrives. What DOES cap it is the
// platform: a Vercel Node function rejects a request body over ~4.5 MB with a
// 413 before this handler is ever invoked (the same cap that forced
// direct-to-storage uploads in WA-PIPELINE #450 and the contractor-invoice
// path #453). Because Postmark base64-encodes inline attachments (~4/3
// expansion), that put the practical inbound ceiling at roughly 3.3 MB of
// attachment bytes per EMAIL — well under Postmark's own limit and under our
// per-file MAX_ATTACHMENT_BYTES. A larger mail did not reach the `too_large`
// branch at all: Postmark saw a 413, retried, and the message was never filed.
//
// EMAIL-INBOUND-SHIM.1 moves that ceiling by putting a Supabase Edge Function
// (supabase/functions/postmark-inbound-shim) in front. Postmark now POSTs the
// fat payload there; it uploads each attachment's bytes into the
// `email-attachments` bucket, replaces each `Content` with a `_un1t_staged`
// reference, forwards the small JSON HERE, and returns whatever this route
// returned — so Postmark's retry semantics are unchanged.
//
// THIS ROUTE STILL ACCEPTS THE ORIGINAL INLINE-BASE64 SHAPE, unchanged, and
// must keep doing so: it is the fallback if the shim is bypassed, mis-deployed
// or rolled back. storeInboundAttachments() handles both. See
// src/lib/email-attachment-staging.js for the wire contract.
//
// AND IT OWNS THE STAGED BYTES. Every exit below that means "this message is
// not being filed" — no parseable sender, an unmatched recipient heading for
// the dead-letter table, or any 5xx answered before the attachment step —
// discards what the shim staged. Nothing else ever will: the rows that would
// have named those objects are the rows this route decided not to write.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { htmlToPlainText } from '@/lib/email-content'
import {
  getHeader,
  extractCandidateMessageIds,
  extractRfcMessageId,
  recipientEmails,
  pickContact,
  inboundPreview,
  truncateHtmlBody,
  senderEmail,
  parseEmailDate,
} from '@/lib/email-inbox'
import { sanitizeDbText } from '@/lib/db-safe-text'
import { logError } from '@/lib/log'
import { recordErrorEvent } from '@/lib/error-events'
import { inboundAddresses } from '@/lib/email-recipients'
import { resolveMailboxByRecipient } from '@/lib/email-mailboxes'
import { resolveTicketAction, ticketSubject, pickThreadedTicket, normalizedSubjectKey } from '@/lib/email-tickets'
import { statusTimestamps } from '@/app/api/email/tickets/_helpers'
import { escapeLikePattern } from '@/lib/like-escape'
import { storeInboundAttachments, discardStagedAttachments } from '@/lib/email-attachments-server'
import { maybeNotifyInboundEmail } from '@/lib/email-inbound-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// EMAIL-DEDUPE-STALE.1 — bound the crash window. The shim in front of this
// route gives up at FORWARD_TIMEOUT_MS (30s); without an explicit cap the
// platform default lets this function outlive that, and — worse — lets an
// attempt keep RUNNING past the stale-claim threshold below, which would let a
// retry reprocess concurrently with a live writer. 20s is 10–100× the route's
// real work (a handful of indexed queries; inline attachment uploads are
// bounded by Vercel's own ~4.5 MB body cap), keeps the shim able to relay a
// real 5xx, and keeps `stale ⇒ owner is dead` true with 3× margin.
export const maxDuration = 20

// A held dedupe claim older than this cannot belong to a live attempt
// (maxDuration kills the function at 20s; 60s adds clock-skew margin). Younger
// claims are treated as in-flight and answered 503 — see classifySeenClaim.
const STALE_CLAIM_MS = 60_000

// The finish-up bump guard (see finishDedupedDelivery): app-clock vs DB-clock
// tolerance when deciding whether a ticket already reflects its last message.
const BUMP_SKEW_MS = 2_000

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
      await recordInboundFailure('dedupe_release_failed', error, {
        message: 'DEDUPE RELEASE FAILED — Postmark will retry this MessageID ' +
          'and the retry will short-circuit as `deduped`, losing the email. ' +
          `event_id=${eventId}`,
      })
      return false
    }
    return true
  } catch (err) {
    await recordInboundFailure('dedupe_release_failed', err, {
      message: 'DEDUPE RELEASE THREW — the retry will short-circuit as ' +
        `\`deduped\` and the email will be lost. event_id=${eventId}`,
    })
    return false
  }
}

// EMAIL-MONITOR.2 — the structured failure trail (2026-08-08 audit). Every
// 5xx door lands an error_events row (route_type 'handled') plus a logError
// line Sentinel can key on — the founding failure of this channel was
// fourteen months of 500s that recorded themselves nowhere. Deliberately NOT
// serverErrorResponse(): this route's 5xx bodies carry shim-contract error
// codes and run through claim-release/unfiled wrappers, so every response
// stays exactly as built and only observability is added. Neither half may
// ever throw — observability must not worsen an incident.
async function recordInboundFailure(code, err, { message } = {}) {
  try {
    logError('postmark-inbound', message || code, { err })
  } catch { /* never */ }
  try {
    await recordErrorEvent({
      runtime: process.env.NEXT_RUNTIME || null,
      route_path: '/api/webhooks/postmark-inbound',
      route_type: 'handled',
      method: 'POST',
      name: code,
      message: String(err?.message || err || code).slice(0, 500),
      digest: null,
    })
  } catch { /* recordErrorEvent already swallows; belt and braces */ }
}

/**
 * What does a held dedupe claim actually mean? See the POST comment for the
 * three verdicts. Errors resolve to 'in_flight' — the safe answer, because a
 * 503 keeps Postmark retrying and a later attempt classifies again — EXCEPT a
 * missing claim row (someone released it between our insert-conflict and this
 * read), which is 'stale': re-processing is what the releaser intended.
 *
 * @returns {Promise<'completed'|'in_flight'|'stale'>}
 */
async function classifySeenClaim(db, messageId, eventId) {
  try {
    const { data: filed, error: filedErr } = await db.from('email_inbox_messages')
      .select('id')
      .eq('postmark_message_id', messageId)
      .limit(1)
    if (filedErr) {
      await recordInboundFailure('claim_classification_failed', filedErr)
      return 'in_flight'
    }
    if (filed && filed.length > 0) {
      // Filed. Whether the dead attempt also finished its bump is decided on
      // the reprocess path (23505 → finishDedupedDelivery) — but only a STALE
      // claim reprocesses; a young one short-circuits, because its owner may
      // be alive between the insert and the bump right now.
      const age = await claimAgeMs(db, eventId)
      if (age !== null && age > STALE_CLAIM_MS) return 'stale'
      return 'completed'
    }
    const age = await claimAgeMs(db, eventId)
    if (age === null) return 'stale' // claim vanished — a releaser beat us
    return age > STALE_CLAIM_MS ? 'stale' : 'in_flight'
  } catch (err) {
    await recordInboundFailure('claim_classification_failed', err)
    return 'in_flight'
  }
}

/** Age of this route's own claim row in ms, or null when it is not there. */
async function claimAgeMs(db, eventId) {
  const { data: claims, error } = await db.from('webhook_events')
    .select('received_at')
    .eq('provider', WEBHOOK_PROVIDERS.POSTMARK)
    .eq('event_id', eventId)
    .limit(1)
  if (error) {
    await recordInboundFailure('claim_age_lookup_failed', error)
    // Unknowable ≠ absent: treat as brand-new so the caller answers 503 and a
    // later retry classifies again, rather than reprocessing blind.
    return 0
  }
  const row = claims?.[0]
  if (!row) return null
  const t = new Date(row.received_at).getTime()
  if (Number.isNaN(t)) return null
  return Date.now() - t
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
      await recordInboundFailure('missing_secret',
        'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN not set — refusing inbound email webhook. ' +
        'THE historic failure mode: every delivery 500s and the queue just looks quiet.')
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
    // EMAIL-DEDUPE-STALE.1 — a held claim is CLASSIFIED, never blindly
    // trusted. The release-on-5xx machinery below closes every door this
    // route ANSWERS through, but the claim commits BEFORE processing, so a
    // door that never answers — a platform kill (timeout/OOM/crash) between
    // the claim insert and the message insert — used to orphan it:
    // Postmark's retry found the claim, got 200 `deduped`, stopped retrying,
    // and the mail was filed nowhere. Three verdicts:
    //
    //   completed — the message row exists (the unique index on
    //     email_inbox_messages.postmark_message_id is the completion marker,
    //     no schema change needed). Genuine re-delivery → short-circuit.
    //   in_flight — no message yet and the claim is younger than any dead
    //     attempt can be (STALE_CLAIM_MS > maxDuration). The first attempt
    //     may still be writing: answer 503 so Postmark keeps the retry chain
    //     alive WITHOUT us racing a live writer. This also closes the
    //     residual window the header used to accept — a retry can no longer
    //     200 while attempt 1 is mid-failure.
    //   stale — no live owner is possible. Re-process under the existing
    //     claim; if the message row does exist after all, the insert's 23505
    //     lands in finishDedupedDelivery, which completes whatever the dead
    //     attempt left undone (attachments, bump, unread).
    //
    // These returns happen BEFORE the claim-holding section below on
    // purpose: the 503 is a 5xx that must NOT release a live owner's claim.
    const verdict = await classifySeenClaim(db, messageId, eventId)
    if (verdict === 'completed') {
      return NextResponse.json({ success: true, deduped: true })
    }
    if (verdict === 'in_flight') {
      return NextResponse.json({ success: false, error: 'claim_in_flight' }, { status: 503 })
    }
    // verdict === 'stale' — fall through and re-process.
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
    await recordInboundFailure('unhandled_error', err)
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
        // DEADLETTER-LOC.1 — the recipient usually still names a mailbox even
        // though processing failed; stamping its location keeps the row inside
        // that studio's integration-health count. Best-effort, never throws.
        locationId: await bestEffortInboundLocation(db, body),
      })
    }
    // Still 500, with the ORIGINAL error untouched: the failure is real, a
    // 200 would tell Postmark to stop retrying, and a client-side error on
    // the DELETE does not prove it failed to commit — the retry may yet land.
  }

  return res
}

// MAILBOX-PAGE.1 — page size and runaway ceiling for the active-mailbox scan.
//
// PostgREST caps EVERY select at 1,000 rows whatever `.limit()` says, so the
// unpaginated read this replaces was silently a `LIMIT 1000` with no ORDER BY.
// 1,000 matches the canonical pager this copies (src/lib/pipeline-reclassify.js).
// The ceiling is a runaway guard, not a working limit: at today's two active
// mailboxes the loop makes exactly ONE query and returns on the short page, so
// this is not an extra round trip on the hot path.
const MAILBOX_PAGE_SIZE = 1000
const MAX_ACTIVE_MAILBOXES = 10_000

/**
 * Every ACTIVE mailbox in the estate, ordered and fully paginated.
 *
 * WHY THIS EXISTS (MAILBOX-PAGE.1)
 * Both readers below used to do a bare `.select().eq('active', true)`. That is
 * the 1,000-row-cap invariant: the row set was capped at 1,000 with NO ORDER BY,
 * so past that many active mailboxes estate-wide the rows PostgREST happened to
 * return decided where a member's email was filed. Two outcomes, both silent:
 * a message resolving to the wrong studio, or dead-lettering as
 * `no_matching_mailbox` while its mailbox exists and is active.
 *
 * That is the same class of bug as the "oldest active location" fallback this
 * route's header describes removing — a routing decision made by something
 * other than the address the mail was sent to.
 *
 * ORDER BY id IS BEHAVIOUR-PRESERVING BELOW THE CAP, and that was verified
 * rather than assumed, because "add an ORDER BY" is only safe if row order
 * cannot change the answer:
 *   • resolveMailboxByRecipient builds its map FIRST-WINS
 *     (`if (!byAddress.has(a))`), so order matters only when two rows produce
 *     the same key.
 *   • The key is `normalizeEmail(address)` = lower(trim(address)).
 *   • `email_mailboxes_address_uidx` is UNIQUE on lower(address) and is NOT
 *     partial — it binds inactive rows too.
 *   • `email_mailboxes_address_shape` forbids whitespace inside an address, so
 *     trim() is a no-op on anything that can be stored.
 * The JS map key is therefore exactly the database's unique key: two rows can
 * never collide, the first-wins branch can never fire, and the order the rows
 * arrive in cannot change which mailbox wins. (Both index and CHECK confirmed
 * against the live database, not just the migration file.)
 *
 * DELIBERATELY DOES NOT CATCH. A thrown error propagates exactly as the bare
 * query's would have: POST releases the dedupe claim on a throw, which is what
 * keeps Postmark's retry alive. Swallowing here would convert a retryable fault
 * into a permanently lost email — the failure class this whole route is about.
 *
 * @returns {Promise<{ok: true, mailboxes: object[]} | {ok: false, error: object}>}
 *   `error` is shaped like a PostgREST error so the caller can hand it to
 *   recordInboundFailure unchanged.
 */
async function loadActiveMailboxes(db) {
  const mailboxes = []
  for (let start = 0; start < MAX_ACTIVE_MAILBOXES; start += MAILBOX_PAGE_SIZE) {
    const end = Math.min(start + MAILBOX_PAGE_SIZE, MAX_ACTIVE_MAILBOXES) - 1
    const { data, error } = await db.from('email_mailboxes')
      .select('id, location_id, address, active')
      .eq('active', true)
      .order('id', { ascending: true })
      .range(start, end)
    if (error) return { ok: false, error }
    const page = Array.isArray(data) ? data : []
    mailboxes.push(...page)
    // A short page means the table is exhausted. This is the canonical repo
    // idiom; it is also why the ceiling below is only reachable by a genuinely
    // enormous estate rather than by a slow page.
    if (page.length < end - start + 1) return { ok: true, mailboxes }
  }
  // Past the ceiling we cannot prove we have the mailbox this mail was sent to,
  // and guessing is what the no-fallback rule exists to forbid. Reported as a
  // lookup FAILURE so it takes the route's existing 500 door — visible in
  // error_events, and retried by Postmark — rather than inventing a new
  // outcome or, worse, filing against a partial set.
  return {
    ok: false,
    error: {
      code: 'mailbox_scan_ceiling',
      message: `More than ${MAX_ACTIVE_MAILBOXES} active mailboxes: refusing to resolve a recipient against a partial set.`,
    },
  }
}

/**
 * DEADLETTER-LOC.1 — best-effort location for a dead-lettered inbound email:
 * the recipient address → active mailbox → location, the same resolution the
 * happy path uses, minus every other requirement. Lets a captured payload
 * land in the right studio's integration-health count even when the mail
 * itself could not be filed. Never throws; null when no mailbox matches
 * (truly unroutable — exactly the rows that should stay NULL).
 */
async function bestEffortInboundLocation(db, body) {
  try {
    // Best-effort by contract: a read failure or the scan ceiling both mean
    // "no location to claim", which is the same NULL this already returned for
    // an unmatched recipient. It must not become a second way to fail a
    // request — its only caller is already on a dead-letter path.
    const loaded = await loadActiveMailboxes(db)
    if (!loaded.ok) return null
    const mailbox = resolveMailboxByRecipient(loaded.mailboxes, recipientEmails(body))
    return mailbox?.location_id ?? null
  } catch {
    return null
  }
}

/**
 * The actual work. Split out of POST ONLY so there is one place to release
 * the dedupe claim on the way out; every `return` below is the response POST
 * answers with, unchanged.
 */
async function processInboundEmail(db, body, messageId) {
  // ── The staged-bytes contract (EMAIL-INBOUND-SHIM.1) ──────────────
  // Wrap every exit that means "nothing here will ever reference the bytes the
  // shim put in the bucket". Written as a wrapper rather than a call at each
  // site so a new early return cannot quietly forget it — and applied ONLY to
  // exits taken BEFORE storeInboundAttachments runs.
  //
  // Deliberately NOT applied to the two `deduped` returns: an earlier attempt
  // already filed this message, and its rows point at these same deterministic
  // keys. Discarding there would delete a stored attachment out from under a
  // live ticket.
  const unfiled = async (res) => {
    await discardStagedAttachments(db, body.Attachments, { postmarkMessageId: messageId })
    return res
  }

  // senderEmail prefers the typed FromFull.Email and falls back to the raw
  // `From` header — which is a DISPLAY string ("Ada <a@b.com>"), so it gets
  // the same angle-bracket extraction as every other display header. The
  // bare parse used to fail on that form and drop mail whose sender was in
  // plain sight.
  const fromEmail = senderEmail(body)
  if (!fromEmail) {
    // A real email always has a sender; without one there is nothing to
    // thread. 200 so Postmark doesn't retry an unfixable payload — but
    // DEAD-LETTERED (EMAIL-INBOUND-NOSENDER.1), not console-warned into the
    // void: a console line in Vercel logs is not a surface anyone triages,
    // and this used to be the one drop with no captured payload. Provider
    // 'postmark_inbound' (pending, operator-visible), NOT the
    // auto-replayable 'postmark' key — same reasoning as no_matching_mailbox
    // below. The staged bytes are still discarded (unfiled): the captured
    // payload keeps the slim marker shape for triage, nothing will ever
    // reference the objects.
    await deadLetterWebhook(db, {
      provider: 'postmark_inbound',
      eventType: 'inbound_email',
      payload: body,
      error: 'no_sender',
      // DEADLETTER-LOC.1 — no sender ≠ no route: the recipient address still
      // names the mailbox this landed on, and stamping its location puts the
      // row in that studio's integration-health count rather than nowhere.
      locationId: await bestEffortInboundLocation(db, body),
    })
    console.warn('[postmark-inbound] no parseable From address — dead-lettered', { messageId })
    return unfiled(NextResponse.json({ success: true, dead_lettered: 'no_sender' }))
  }

  // ── Threading resolution ──────────────────────────────────────────
  const headers = Array.isArray(body.Headers) ? body.Headers : []
  const recipients = recipientEmails(body)
  let contactId = null
  let matchedVia = 'unmatched'

  // (a) matched_via only. EMAIL-PARTICIPANTS.10 removed the CONTACT link that
  // used to be taken from here.
  //
  // The header is supplied by the sender. "From matches no contact, and a
  // threading header names a send to contact X" describes BOTH a member writing
  // in from a second address AND a stranger who was forwarded our mail — the
  // code cannot tell them apart, and one of those outcomes writes a third
  // party's correspondence onto a member's timeline and into their DSAR export.
  // An unlinked message is honest; a wrongly-linked one is a data-integrity
  // breach. Threading and identity are separate questions; conflating them was
  // the error. Contact linkage is now the From address or nothing.
  //
  // The query itself STAYS: the row's existence is what still distinguishes
  // "this replies to one of OUR sends" from "this carries some threading
  // header", which is the whole content of the in_reply_to diagnostic. Nothing
  // else reads it — contact_id is gone from the select, sent_at only orders and
  // postmark_message_id only filters. Deriving it from `candidates.length`
  // instead would BROADEN it: email_sends.contact_id is NOT NULL, so a staff
  // reply to an UNLINKED requester writes no email_sends row at all, and that
  // requester's later reply carries a real threading header with nothing of
  // ours behind it. Pinned by a test ('reports from_address when a threading
  // header names no send of ours').
  //
  // KNOW WHAT IT COSTS before you extend it. matchedVia is returned in the
  // response body and persisted NOWHERE, so this query buys a string that only
  // Postmark's activity log ever shows — while its failure branch below still
  // 5xxes the whole inbound. That trade is fine as it stands (the read is
  // indexed, and the 5xx gives the dedupe claim back so Postmark's retry really
  // re-processes) but it is the wrong shape to hang anything heavier on: a
  // diagnostic must never be the reason a member's email fails to file.
  //
  // sanitizeDbText on each candidate (EMAIL-INBOUND-POISON.1): a NUL inside
  // In-Reply-To would otherwise ride into the `.in()` filters and can fail
  // the SELECT itself — another deterministic 5xx. Our own stored ids never
  // contain these bytes, so a stripped candidate matches exactly what an
  // attacker could already match by typing the clean id directly.
  const candidates = extractCandidateMessageIds(headers)
    .map(sanitizeDbText)
    .filter(Boolean)
    .slice(0, MAX_THREAD_CANDIDATES)
  if (candidates.length) {
    const { data: sends, error: sendsErr } = await db.from('email_sends')
      .select('postmark_message_id, sent_at')
      .in('postmark_message_id', candidates)
      .order('sent_at', { ascending: false })
      .limit(1)
    if (sendsErr) {
      await recordInboundFailure('thread_lookup_failed', sendsErr)
      return unfiled(NextResponse.json({ success: false, error: 'thread_lookup_failed' }, { status: 500 }))
    }
    if (sends?.[0]) matchedVia = 'in_reply_to'
  }

  // Recipient address → mailbox → location. AUTHORITATIVE, and the only
  // thing that decides where this mail is filed. Match in JS
  // (resolveMailboxByRecipient also enforces the recipient precedence order,
  // so a message addressed to two of our mailboxes resolves the same way
  // regardless of what order the rows came back in).
  //
  // MAILBOX-PAGE.1 — paginated and ordered. This read used to be bare, which
  // made it a silent `LIMIT 1000` with no ORDER BY on the one query that
  // decides which studio a member's email belongs to. See loadActiveMailboxes
  // for why ORDER BY id cannot change the answer below the cap.
  const loaded = await loadActiveMailboxes(db)
  if (!loaded.ok) {
    await recordInboundFailure('mailbox_lookup_failed', loaded.error)
    return unfiled(NextResponse.json({ success: false, error: 'mailbox_lookup_failed' }, { status: 500 }))
  }
  const mailboxes = loaded.mailboxes
  const mailbox = resolveMailboxByRecipient(mailboxes, recipients)
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
    //
    // location_id stays NULL on purpose (DEADLETTER-LOC.1): no mailbox
    // matched, so there is no location to claim — inventing one would repeat
    // the oldest-active-location bug this route exists to prevent. The
    // integration-health count is NULL-inclusive, so the row still surfaces.
    await deadLetterWebhook(db, {
      provider: 'postmark_inbound',
      eventType: 'inbound_email',
      payload: body,
      error: 'no_matching_mailbox',
    })
    console.warn('[postmark-inbound] no active mailbox matched — dead-lettered', {
      messageId, recipients,
    })
    return unfiled(NextResponse.json({ success: true, dead_lettered: 'no_matching_mailbox' }))
  }
  const locationId = mailbox.location_id

  // EMAIL-INBOUND-PUSH.1 — every address of ours, so the push fan-out never
  // announces our own outbound arriving at our own webhook (compose from
  // sales@ to accounts@, a member's reply-all echoing us). Derived from the
  // ACTIVE list already fetched above; an inactive address that still mails us
  // is rare enough that a spurious ping beats an extra query on every inbound.
  const ownAddresses = [
    ...(mailboxes || []).map(m => m.address),
    process.env.POSTMARK_FROM_EMAIL,
  ]

  // (b) From address → contacts (deterministic pick; prefer the mailbox's
  // location). THE ONLY source of contact linkage (EMAIL-PARTICIPANTS.10), so
  // it is unconditional — it used to be skipped whenever (a) had already taken
  // a contact off the sender-supplied header.
  //
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
    await recordInboundFailure('contact_lookup_failed', cErr)
    return unfiled(NextResponse.json({ success: false, error: 'contact_lookup_failed' }, { status: 500 }))
  }
  const picked = pickContact(contacts || [], locationId)
  if (picked) {
    contactId = picked.id
    // 'in_reply_to' still wins: it is the stronger statement about the THREAD,
    // and matched_via has always reported the strongest signal available.
    if (matchedVia === 'unmatched') matchedVia = 'from_address'
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
      await recordInboundFailure('ticket_lookup_failed', threadErr)
      return unfiled(NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 }))
    }
    const threadedTicketId = pickThreadedTicket([...(byRfc.data || []), ...(byPostmark.data || [])])
    if (threadedTicketId) {
      // mailbox_id + unread_count ride along for the push fan-out below: the
      // TICKET'S mailbox decides who may be told, and the PRE-increment unread
      // count is the one-ping-per-unseen-burst gate (EMAIL-INBOUND-PUSH.1).
      const { data: found, error: tErr } = await db.from('email_tickets')
        .select('id, status, subject, first_response_at, mailbox_id, unread_count, assigned_to')
        .eq('id', threadedTicketId)
        .eq('location_id', locationId)
        .maybeSingle()
      if (tErr) {
        await recordInboundFailure('ticket_lookup_failed', tErr)
        return unfiled(NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 }))
      }
      threadedTicket = found || null
    }
  }
  // MAIL-REFINE.1 — the broken-chain fallback, tried only when RFC threading
  // found NOTHING: same mailbox, same sender, same normalised subject, on an
  // OPEN unmerged thread → this is the conversation whose reply chain a mail
  // client broke, so append rather than fork. Strictly narrower than
  // threading (open-only, same-mailbox-only, exact key) because a false match
  // files a stranger topic into the wrong thread — and it FAILS OPEN: any
  // error here means "create a fresh ticket", exactly what happened before
  // this existed. Never a reason to lose or 5xx the message.
  if (!threadedTicket) {
    // Audit M5 — key the SANITIZED subject: the stored ticket subject went
    // through sanitizeDbText, so a poison byte in the raw Subject would
    // otherwise make the two keys unequal forever (fail-open fork, no harm —
    // but the append this fallback exists for would never happen).
    const subjectKey = normalizedSubjectKey(sanitizeDbText(body.Subject))
    if (subjectKey) {
      try {
        const { data: sameSender, error: sameErr } = await db.from('email_tickets')
          .select('id, status, subject, first_response_at, mailbox_id, unread_count, assigned_to')
          .eq('location_id', locationId)
          .eq('mailbox_id', mailbox.id)
          // escapeLikePattern: the sender is attacker-controlled and stored
          // mixed-case — case-insensitive EQUALITY, never a pattern.
          .ilike('requester_email', escapeLikePattern(fromEmail))
          .eq('status', 'open')
          .is('merged_into_id', null)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(20)
        if (!sameErr) {
          threadedTicket = (sameSender || [])
            .find(t => normalizedSubjectKey(t.subject) === subjectKey) || null
        } else {
          console.error('[postmark-inbound] subject-fallback lookup failed:', sameErr.message)
        }
      } catch (e) {
        console.error('[postmark-inbound] subject-fallback lookup threw:', e?.message)
      }
    }
  }

  const action = resolveTicketAction(threadedTicket)

  // EMAIL-INBOUND-POISON.1 — every attacker-suppliable string is stripped of
  // what Postgres text cannot hold (NUL, lone surrogates) BEFORE the inserts.
  // Unsanitised, one poison byte failed the insert deterministically and the
  // message 5xx-looped through its whole retry schedule, never filed. The
  // HtmlBody strip runs AFTER truncateHtmlBody on purpose: the UTF-16 slice
  // can itself orphan a surrogate at the cut point.
  const subject = sanitizeDbText(body.Subject) || null
  const counterpartName = sanitizeDbText(body.FromFull?.Name) || null
  const textBody = sanitizeDbText((body.TextBody || '').trim())
    || sanitizeDbText(htmlToPlainText(body.HtmlBody))
    || ''
  const now = new Date().toISOString()
  const preview = inboundPreview(textBody) || (subject ? inboundPreview(subject) : '')
  // EMAIL-CC.1 — the To and Cc headers, kept apart. Both capped at
  // MAX_STORED_RECIPIENTS inside inboundAddresses: a stranger can put 500
  // addresses in a Cc header and an unbounded text[] would ride along on every
  // read of this ticket forever.
  const toEmails = inboundAddresses(body.ToFull, body.To)
  const ccEmails = inboundAddresses(body.CcFull, body.Cc)

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
        // MAIL-SENT.1 — born of a received message.
        has_inbound: true,
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
      await recordInboundFailure('ticket_insert_failed', ticketErr)
      return unfiled(NextResponse.json({ success: false, error: 'ticket_insert_failed' }, { status: 500 }))
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
    // to_email is UNCHANGED — still the first entry of the merged recipient
    // list that mailbox routing already uses. EMAIL-CC.1 adds the two arrays
    // beside it and touches nothing that decides where this mail is filed:
    // `recipients`, resolveMailboxByRecipient() and pickThreadedTicket() are
    // all exactly as they were.
    to_email: recipients[0] || null,
    // Split apart properly now (mig 499). `recipients` deliberately MERGES To
    // and Cc — it answers "was this delivered to one of our mailboxes", where
    // the distinction does not matter — but the thread has to show WHO the
    // member copied, and for that it does. Falls back to the merged list's
    // first entry so a payload with no ToFull/To (envelope-only, rewritten
    // headers) still records the address the mail actually reached.
    to_emails: toEmails.length ? toEmails : (recipients[0] ? [recipients[0]] : []),
    // THE MEMBER'S OWN Cc, captured at last. Stored as sent — including any of
    // our other mailboxes they happened to copy, because that is the truth of
    // the header and hiding it would misrepresent the thread. Our addresses are
    // excluded at SEND time instead (loadOwnAddresses), which is the only place
    // the distinction can do harm.
    //
    // bcc_emails is deliberately absent and stays '{}' forever on inbound: a
    // Bcc is invisible to the receiving server, so any value here would be a
    // fabrication.
    cc_emails: ccEmails,
    subject,
    text_body: textBody,
    // Truncate FIRST, then strip — the slice can orphan a surrogate pair at
    // its cut point, and that orphan fails the insert like any other.
    html_body: sanitizeDbText(truncateHtmlBody(body.HtmlBody || null)),
    postmark_message_id: messageId,
    rfc_message_id: sanitizeDbText(extractRfcMessageId(headers)),
    in_reply_to: sanitizeDbText(getHeader(headers, 'In-Reply-To')),
    references_header: sanitizeDbText(getHeader(headers, 'References')),
    status: 'received',
    // parseEmailDate never throws — `new Date(body.Date).toISOString()` did,
    // on a malformed attacker-supplied Date, 5xx-looping the whole payload.
    sent_at: parseEmailDate(body.Date) || now,
  })
    .select('id')
    .single()
  if (msgErr) {
    // 23505 = the unique postmark_message_id index says the message row
    // already exists — a previous attempt filed it and then failed or died
    // AFTER the insert (a fully-successful attempt keeps its claim, so a
    // re-delivery short-circuits in classifySeenClaim and never gets here).
    // Finish what that attempt may have left undone rather than answering
    // `deduped` with the bump and attachments missing.
    if (msgErr.code === '23505') {
      return finishDedupedDelivery(db, {
        body, messageId, locationId, mailboxId: mailbox.id, now, preview,
        pushContext: { fromEmail, ownAddresses, requesterName: counterpartName, subject },
      })
    }
    await recordInboundFailure('message_insert_failed', msgErr)
    return unfiled(NextResponse.json({ success: false, error: 'message_insert_failed' }, { status: 500 }))
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
        // Postmark's own MessageID, NOT the row id above. It is what the shim
        // keyed its objects on, so it is what re-derives and validates a
        // `_un1t_staged` path. Without it every marker reads as rehost_failed —
        // fail-safe, never fail-open.
        postmarkMessageId: messageId,
      })
      if (stored.skipped > 0) {
        console.warn('[postmark-inbound] attachments not stored', {
          messageId, ticketId, ...stored.reasons,
        })
      }
    } catch (err) {
      logError('postmark-inbound', 'attachment storage threw (email still filed)', { err })
    }
  }

  // ── Bump the ticket ───────────────────────────────────────────────
  // CHECKED since EMAIL-BUMP-CHECK.1 (it was fire-and-forget): the message is
  // filed, but a lost bump leaves a closed/stale ticket with an unseen reply
  // inside — invisible in every queue view. Failing here 5xxes, the claim is
  // released on the way out, and Postmark's retry lands on the 23505 path
  // above, whose finishDedupedDelivery re-runs this exact bump. Deliberately
  // BEFORE the unread rpc, so the retry increments exactly once.
  if (action.action === 'append') {
    const bumped = await bumpTicketForInbound(db, ticketId, { now, preview })
    if (!bumped) {
      return NextResponse.json({ success: false, error: 'ticket_bump_failed' }, { status: 500 })
    }
  }
  // supabase-js builders are thenables with no .catch — try/catch, not
  // .catch(), or the rpc never fires.
  try { await db.rpc('increment_email_ticket_unread', { p_ticket_id: ticketId }) } catch {}

  // ── Tell the staff (EMAIL-INBOUND-PUSH.1) ─────────────────────────
  // Last, and subordinate to everything above: the mail is filed whether or
  // not anyone is pinged, matching the WhatsApp/Instagram webhooks' posture.
  // Recipient gating (email_inbox at this location + a grant on the TICKET'S
  // mailbox, or elevated), the one-ping-per-unseen-burst batching and the
  // own-address suppression all live in maybeNotifyInboundEmail; the route
  // only reports the facts. Note the mailbox handed over is the ticket's on
  // an append — visibility follows where the THREAD lives, which can differ
  // from (or, for mig 484 backfill rows, predate) the delivering address.
  try {
    await maybeNotifyInboundEmail(db, {
      locationId,
      ticketId,
      ticketMailboxId: action.action === 'append'
        ? (threadedTicket?.mailbox_id ?? null)
        : mailbox.id,
      fromEmail,
      ownAddresses,
      requesterName: counterpartName,
      subject,
      preview,
      // PRE-increment on purpose: read off the ticket row before this
      // message's bump, so a burst onto an already-unseen ticket pings once.
      preUnreadCount: action.action === 'append' ? (threadedTicket?.unread_count || 0) : 0,
      // EMAIL-PUSH-ASSIGNEE.1 — an owned ticket pings its owner alone
      // (subject to the fan-out's own gates). Only an append can carry one:
      // a freshly-created ticket has no owner (no auto-assign,
      // EMAIL-ASSIGN.1-2).
      assignedTo: action.action === 'append' ? (threadedTicket?.assigned_to ?? null) : null,
    })
  } catch (err) {
    console.error('[postmark-inbound] push failed (email still filed)', err?.message)
  }

  return NextResponse.json({
    success: true,
    ticket_id: ticketId,
    mailbox_id: mailbox.id,
    matched_via: matchedVia,
  })
}

/**
 * The inbound summary bump. No `subject` on purpose: a ticket is named by the
 * issue that opened it — mig 394 tracked the latest inbound and thread names
 * drifted with every "Re: Re: Fwd:".
 */
async function bumpTicketForInbound(db, ticketId, { now, preview }) {
  const { error } = await db.from('email_tickets').update({
    status: 'open',
    // statusTimestamps' invariant (2026-08-08 audit): moving OUT of
    // solved/closed CLEARS the stamps. The staff status and reply routes
    // already honoured it; this bump — which is also the reopen path, and is
    // re-run verbatim by finishDedupedDelivery — did not, so a reopened
    // ticket kept its old solved_at and a later re-solve preserved the stale
    // stamp as though the member's reply never happened.
    ...statusTimestamps('open', null, now),
    last_message_at: now,
    // MAIL-SENT.1 — the first reply to a compose thread lands here: the
    // thread moves from Sent to Inbox on this very write.
    has_inbound: true,
    last_message_direction: 'inbound',
    last_message_preview: preview,
    updated_at: now,
  }).eq('id', ticketId)
  if (error) {
    await recordInboundFailure('ticket_bump_failed', error)
    return false
  }
  return true
}

/**
 * The 23505 path: the message row exists, written by an attempt that then
 * failed or died. Complete the parts it may not have reached — attachments
 * (idempotent by (message_id, attachment_index) + deterministic object keys),
 * the ticket bump and the unread increment — against the WINNING row, then
 * answer `deduped`.
 *
 * The bump is guarded by state, not by memory of who did what: if the winning
 * ticket's last_message_at already covers the winning message's created_at,
 * the bump (or a later message's) has landed and re-running it would REOPEN a
 * ticket on a stray re-delivery of old mail. BUMP_SKEW_MS absorbs the
 * app-clock/DB-clock gap between our `now` stamp and the row default.
 *
 * Residual, accepted: an attempt killed in the microseconds between its
 * unread rpc and its 200 leaves a retry that re-increments once — unread off
 * by one beats a reply nobody is told about.
 */
async function finishDedupedDelivery(db, { body, messageId, locationId, mailboxId, now, preview, pushContext }) {
  const { data: winners, error: findErr } = await db.from('email_inbox_messages')
    .select('id, ticket_id, created_at')
    .eq('postmark_message_id', messageId)
    .limit(1)
  const winner = winners?.[0]
  if (findErr || !winner) {
    // 23505 said the row exists; not being able to read it back is transient.
    // 5xx → release → retry, rather than a `deduped` that skipped the bump.
    await recordInboundFailure('dedupe_finish_failed', findErr || 'row not found')
    return NextResponse.json({ success: false, error: 'dedupe_finish_failed' }, { status: 500 })
  }

  // Same call as the primary path, against the winning row's id. Everything
  // already recorded is skipped; anything the dead attempt never reached is
  // stored and metered now. Never fails the response — same governing rule.
  if (Array.isArray(body.Attachments) && body.Attachments.length > 0) {
    try {
      const stored = await storeInboundAttachments(db, {
        attachments: body.Attachments,
        messageId: winner.id,
        locationId,
        mailboxId,
        postmarkMessageId: messageId,
      })
      if (stored.skipped > 0) {
        console.warn('[postmark-inbound] finish-up attachments not stored', {
          messageId, ...stored.reasons,
        })
      }
    } catch (err) {
      logError('postmark-inbound', 'finish-up attachment storage threw', { err })
    }
  }

  if (!winner.ticket_id) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const { data: tickets, error: tErr } = await db.from('email_tickets')
    .select('id, last_message_at, mailbox_id, unread_count, assigned_to')
    .eq('id', winner.ticket_id)
    .limit(1)
  if (tErr) {
    await recordInboundFailure('dedupe_finish_failed', tErr)
    return NextResponse.json({ success: false, error: 'dedupe_finish_failed' }, { status: 500 })
  }
  const ticket = tickets?.[0]
  if (ticket) {
    const messageAt = new Date(winner.created_at || 0).getTime() || 0
    const bumpedAt = ticket.last_message_at ? (new Date(ticket.last_message_at).getTime() || 0) : 0
    if (bumpedAt < messageAt - BUMP_SKEW_MS) {
      const bumped = await bumpTicketForInbound(db, winner.ticket_id, { now, preview })
      if (!bumped) {
        return NextResponse.json({ success: false, error: 'ticket_bump_failed' }, { status: 500 })
      }
      try { await db.rpc('increment_email_ticket_unread', { p_ticket_id: winner.ticket_id }) } catch {}
      // The dead attempt's push runs AFTER its bump, so a missing bump proves
      // the push never fired either — the finish-up owes staff the ping too
      // (EMAIL-INBOUND-PUSH.1). Guarded by the SAME state check as the bump:
      // a late manual re-delivery of already-handled mail lands in the
      // else-branch above and pings nobody. Same pre-increment unread gate.
      try {
        await maybeNotifyInboundEmail(db, {
          locationId,
          ticketId: winner.ticket_id,
          ticketMailboxId: ticket.mailbox_id ?? null,
          ...pushContext,
          preview,
          preUnreadCount: ticket.unread_count || 0,
          assignedTo: ticket.assigned_to ?? null,
        })
      } catch (err) {
        console.error('[postmark-inbound] finish-up push failed (email still filed)', err?.message)
      }
    }
  }

  return NextResponse.json({ success: true, deduped: true })
}
