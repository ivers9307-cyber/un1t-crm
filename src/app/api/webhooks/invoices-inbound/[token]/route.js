// INVOICES.1 — Postmark inbound webhook for the Dext-style email-in
// invoice ingest.
//
// Postmark routes mail addressed to *@<server>.inbound.postmarkapp.com
// (or our configured custom inbound domain) here. We rely on the
// recipient address — `<slug>-invoices@mail.un1tdublin.com` — to pick
// the location. The slug column on `locations` is unique partial,
// so a slug-collision is impossible.
//
// Auth — token-in-URL pattern:
//   Postmark's inbound webhook config only lets you set a URL, NOT
//   custom headers, so we can't use the X-Webhook-Token shared-
//   secret pattern the outbound delivery webhook uses. Instead the
//   secret lives in the URL path: configure Postmark to POST to
//   https://crm.un1tdublin.com/api/webhooks/invoices-inbound/<token>
//   where <token> is a long random string set in env as
//   POSTMARK_INBOUND_WEBHOOK_TOKEN. We constant-time compare on
//   each request. Same pattern as the sequence webhook (mig 131).
//   For rotation: set POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS to
//   the old value, switch Postmark to the new URL, then unset
//   PREVIOUS once you've confirmed traffic is on the new token.
//
// Flow:
//   1. URL-token auth (above).
//   2. Parse the payload — Postmark Inbound shape: { To, ToFull,
//      From, FromFull, Subject, MessageID, Attachments[...] }.
//   3. Claim the MessageID in webhook_events. The claim is an audit record
//      and a hint ("deduped: true" in the answer), not a gate: see below.
//   4. Find the slug from ToFull (preferred — array of { Email, Name })
//      falling back to To, then OriginalRecipient.
//   5. Resolve slug → location_id via `locations.invoices_inbound_slug`.
//   6. ingestInboundEmail stores every supported attachment (one
//      invoices_queue row each) or one empty row when nothing is usable.
//   7. Return 200. The inbox UI then shows the row and the operator
//      does quality review.
//
// Why we don't queue here like the outbound webhook does:
//   • Inbound volume is single-digit per day — no burst risk.
//   • Each event creates a row regardless; deferring the write
//     would just add a hop.
//
// Failure handling: Postmark retries only on non-2xx. What makes a retry safe
// is the store, not the claim: ingestInboundEmail and recordInboundStray are
// idempotent per email, so a repeat delivery is processed again and a true
// duplicate stores nothing new. A held claim is therefore never trusted to
// mean "stored": a failed release or a run killed mid-ingest leaves it held,
// and dropping the retry then would lose the email. Every failure after the
// claim (lookup, storing, stray write, or an unexpected throw) still releases
// the claim and answers 500, so the record stays accurate.
//   • Mail that matches no studio (unparseable or unknown address) is
//     recorded in invoice_inbound_strays and answered 200: retrying cannot
//     help, but the email stays visible instead of vanishing into a log.
//   • An email with nothing usable attached still gets an empty queue row.
// Not covered: when the mail provider points straight at this URL, an email
// whose payload is larger than the platform's request size limit is refused
// before this handler runs, so nothing here records it. Behind the shim it
// arrives staged.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, releaseWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { parseInboundAddress } from '@/lib/inbound-invoices'
import { ingestInboundEmail } from '@/lib/invoices-queue/ingest-email'
import { recordInboundStray } from '@/lib/invoices-queue/strays'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Several attachments are uploaded one after another; leave room for that.
export const maxDuration = 60

/**
 * Token-in-URL auth — Postmark inbound webhooks don't allow custom
 * headers, so the shared secret lives in the URL path itself. We
 * timing-safe compare to defend against length-leak side channels.
 * Both the primary token and an optional PREVIOUS rotation token
 * are accepted; configure Postmark to POST to the URL containing
 * the primary, set PREVIOUS to the old token during rotation, then
 * unset PREVIOUS once you've confirmed the switchover.
 *
 * Exported for the route test so it can exercise the auth gate
 * without standing up a full request fixture.
 */
export function verifyInboundRequest({ urlToken, primarySecret, previousSecret }) {
  if (!primarySecret) return { ok: false, status: 500, reason: 'missing_secret' }
  if (!urlToken) return { ok: false, status: 404, reason: 'missing_token' }
  const primary = verifySharedSecret(urlToken, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }
  if (previousSecret) {
    const previous = verifySharedSecret(urlToken, previousSecret)
    if (previous.ok) return { ok: true, matched: 'previous' }
  }
  // We 404 (not 403) on a wrong token — denies an attacker the
  // signal "yes, this URL pattern exists, you just got the token
  // wrong". Same approach as the sequence webhook.
  return { ok: false, status: 404, reason: 'token_mismatch' }
}

export async function POST(request, { params }) {
  const { token } = await params
  const auth = verifyInboundRequest({
    urlToken: token,
    primarySecret: process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN,
    previousSecret: process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      logError('invoices-inbound', 'POSTMARK_INBOUND_WEBHOOK_TOKEN not set — refusing inbound invoice webhook')
    } else {
      logWarn('invoices-inbound', `inbound invoice webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    logWarn('invoices-inbound',
      'accepted via POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating the Postmark inbound URL to the new token, then unset PREVIOUS.')
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

  const eventId = `inbound-invoice:${messageId}`
  // A held claim is not proof the email was stored (see the header), so a
  // repeat is processed like the first delivery; the idempotent store keeps it
  // from adding rows. The answer only says it was a repeat.
  const dedup = await recordWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.POSTMARK, eventId })
  const repeat = dedup.seen ? { deduped: true } : {}
  const fail = async (error) => {
    // Release first: the provider's retry must not be mistaken for a duplicate.
    await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.POSTMARK, eventId })
    return NextResponse.json({ success: false, error }, { status: 500 })
  }

  try {
    // Resolve recipient → slug → location.
    //
    // Postmark gives us three places the slug might appear, in
    // priority order:
    //   1. ToFull[] — typed-recipient list (preferred — already
    //      normalised by Postmark into { Email, Name, MailboxHash })
    //   2. To — display string "Name <addr>, Name <addr>"
    //   3. OriginalRecipient — the actual envelope RCPT TO from
    //      the SMTP transaction. Per the Postmark spec, when an
    //      email is CC'd or BCC'd or routed via a forwarding domain
    //      that rewrote the visible To, this is the ground truth
    //      of where Postmark received the mail.
    //
    // Falling back through all three avoids silently dropping
    // legitimate invoices that were addressed to the slug via Cc/Bcc
    // or a forwarding hop.
    const slug =
      parseInboundAddress(body.ToFull) ||
      parseInboundAddress(body.To) ||
      parseInboundAddress(body.OriginalRecipient)

    const stray = async (reason, ignoredSlug) => {
      logWarn('invoices-inbound', `recording stray: ${reason}`, { messageId, slug: ignoredSlug })
      const { ok } = await recordInboundStray(db, {
        messageId,
        to: body.OriginalRecipient || body.To || null,
        from: body.FromFull?.Email || body.From || null,
        subject: body.Subject || null,
        reason,
        slug: ignoredSlug,
      })
      if (!ok) return fail('stray_insert_failed')
      return NextResponse.json(
        reason === 'unknown_slug'
          ? { success: true, ...repeat, ignored: reason, slug: ignoredSlug }
          : { success: true, ...repeat, ignored: reason },
      )
    }

    if (!slug) return await stray('unparseable_recipient', null)

    const { data: location, error: locErr } = await db
      .from('locations')
      .select('id, name, invoices_inbound_slug')
      .eq('invoices_inbound_slug', slug)
      .maybeSingle()
    if (locErr) {
      logError('invoices-inbound', 'location lookup failed', { messageId, error: locErr.message })
      return await fail('location_lookup_failed')
    }
    if (!location) return await stray('unknown_slug', slug)

    const result = await ingestInboundEmail(db, { location: { id: location.id }, body })
    if (!result.ok) {
      logError('invoices-inbound', 'ingest failed', { messageId, error: result.error })
      return await fail(result.error)
    }
    return NextResponse.json({ success: true, ...repeat, created: result.created.length, ids: result.created, notReceived: result.notReceived })
  } catch (err) {
    logError('invoices-inbound', 'unexpected failure', { messageId, error: err?.message })
    return await fail('internal_error')
  }
}
