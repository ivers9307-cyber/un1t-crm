// INVOICES.1 — Postmark inbound webhook for the Dext-style email-in
// invoice ingest.
//
// Postmark routes mail addressed to *@<server>.inbound.postmarkapp.com
// (or our configured custom inbound domain) here. We rely on the
// recipient address — `<slug>-invoices@un1tdublin.com` — to pick
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
//   3. Find the slug from ToFull (preferred — array of { Email, Name })
//      falling back to To (comma-separated string).
//   4. Resolve slug → location_id via `locations.invoices_inbound_slug`.
//   5. Idempotency dedup keyed on Postmark MessageID.
//   6. For each supported attachment, upload to storage + insert one
//      inbound_invoices row in status='received'. Multiple attachments
//      = multiple rows (one invoice per attachment is the operating
//      assumption — multi-page PDFs are a single row).
//   7. Return 200 fast. The inbox UI then shows the row and the
//      operator does quality review.
//
// Why we don't queue here like the outbound webhook does:
//   • Inbound volume is single-digit per day — no burst risk.
//   • Each event creates a row regardless; deferring the write
//     would just add a hop.
//
// Failure modes that return 200 (with a warning logged) so Postmark
// doesn't retry forever:
//   • Slug not found → log + 200. Likely a typo'd address or a
//     decommissioned location; retrying won't help.
//   • Attachment missing/unsupported → 200, log; the inbound email
//     was real but had nothing to ingest.
// Storage / DB errors return 5xx so Postmark retries naturally.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import {
  parseInboundAddress,
  INBOUND_INVOICE_SUPPORTED_MIME,
  inboundInvoiceStoragePath,
  safeInboundFilename,
} from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'

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
      console.error('[security] POSTMARK_INBOUND_WEBHOOK_TOKEN not set — refusing inbound invoice webhook.')
    } else {
      console.warn(`[security] Inbound invoice webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    console.warn(
      '[security] Inbound invoice webhook accepted via POSTMARK_INBOUND_WEBHOOK_TOKEN_PREVIOUS — ' +
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

  // Idempotency — Postmark retries on 5xx. Don't double-ingest.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: `inbound-invoice:${messageId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Resolve recipient → slug → location.
  const slug = parseInboundAddress(body.ToFull) || parseInboundAddress(body.To)
  if (!slug) {
    console.warn('[invoices-inbound] could not parse slug from recipient', { To: body.To, ToFull: body.ToFull })
    return NextResponse.json({ success: true, ignored: 'unparseable_recipient' })
  }

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name, invoices_inbound_slug')
    .eq('invoices_inbound_slug', slug)
    .maybeSingle()
  if (locErr) {
    console.error('[invoices-inbound] location lookup failed:', locErr.message)
    return NextResponse.json({ success: false, error: 'location_lookup_failed' }, { status: 500 })
  }
  if (!location) {
    console.warn('[invoices-inbound] unknown slug', { slug })
    return NextResponse.json({ success: true, ignored: 'unknown_slug', slug })
  }

  const attachments = Array.isArray(body.Attachments) ? body.Attachments : []
  const supported = attachments.filter((a) => INBOUND_INVOICE_SUPPORTED_MIME.has(a?.ContentType))
  if (supported.length === 0) {
    console.warn('[invoices-inbound] no supported attachments', {
      slug, messageId, total: attachments.length,
      mimeTypes: attachments.map((a) => a?.ContentType),
    })
    // Still create a row so the operator can see the email arrived
    // with no usable attachment — they can reject it manually.
    const senderEmail = body.FromFull?.Email || body.From || null
    const { error: insErr } = await db.from('inbound_invoices').insert({
      location_id: location.id,
      sender_email: senderEmail,
      subject: body.Subject || null,
      email_message_id: messageId,
      status: 'received',
    })
    if (insErr) {
      console.error('[invoices-inbound] empty-attachment row insert failed:', insErr.message)
      return NextResponse.json({ success: false, error: 'insert_failed' }, { status: 500 })
    }
    return NextResponse.json({ success: true, created: 1, attachments: 0 })
  }

  const senderEmail = body.FromFull?.Email || body.From || null
  const created = []

  // For the multi-attachment case Postmark's MessageID is the SAME
  // for every row we create from this email. The unique constraint
  // on email_message_id would block N>1 rows. We salt the second+
  // attachments with a "-<index>" suffix so each row gets its own
  // unique value while still tracing back to the same email. The
  // dedup at the top of the handler is keyed on the bare MessageID,
  // so a Postmark retry still short-circuits before we land here.
  for (let i = 0; i < supported.length; i++) {
    const att = supported[i]
    const filename = safeInboundFilename(att.Name) || `attachment-${i + 1}`
    const content = att.Content // base64 string
    let bytes
    try {
      bytes = Buffer.from(content, 'base64')
    } catch {
      console.warn('[invoices-inbound] skipping unparseable base64 attachment', { filename })
      continue
    }
    if (!bytes.length) continue

    // Insert the row FIRST (status='received', no attachment_path
    // yet) so we have an id to use in the storage path. Then upload.
    // On upload failure we delete the row to avoid orphans.
    const { data: row, error: insErr } = await db
      .from('inbound_invoices')
      .insert({
        location_id: location.id,
        sender_email: senderEmail,
        subject: body.Subject || null,
        email_message_id: i === 0 ? messageId : `${messageId}-${i}`,
        attachment_filename: filename,
        attachment_size_bytes: bytes.length,
        attachment_mime_type: att.ContentType,
        status: 'received',
      })
      .select('id')
      .single()
    if (insErr || !row) {
      console.error('[invoices-inbound] row insert failed:', insErr?.message)
      return NextResponse.json({ success: false, error: 'insert_failed' }, { status: 500 })
    }

    const storagePath = inboundInvoiceStoragePath({
      locationId: location.id,
      invoiceId: row.id,
      safeFilename: filename,
    })

    const { error: upErr } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, {
        contentType: att.ContentType,
        upsert: false,
      })
    if (upErr) {
      console.error('[invoices-inbound] storage upload failed:', upErr.message)
      // Roll back the row so we don't leave a phantom inbox entry.
      await db.from('inbound_invoices').delete().eq('id', row.id)
      return NextResponse.json({ success: false, error: 'storage_upload_failed' }, { status: 500 })
    }

    const { error: updErr } = await db
      .from('inbound_invoices')
      .update({ attachment_path: storagePath })
      .eq('id', row.id)
    if (updErr) {
      console.error('[invoices-inbound] row update failed:', updErr.message)
      // Don't delete — the file is uploaded; manual recovery from
      // the inbox UI is easier than a dangling file.
    }

    created.push(row.id)
  }

  return NextResponse.json({ success: true, created: created.length, ids: created })
}
