// /api/webhooks/glofox — inbound receiver for Glofox webhooks
// (GLOFOX1 + GLOFOX1.6 refactor to per-location credentials).
//
// Glofox POSTs JSON for booking / membership / member / access
// events. We:
//   1. Parse the raw body to extract the branch_id (the only piece
//      of info we need BEFORE auth so we can look up the right
//      webhook secret per location).
//   2. Look up the location by branch_id (locations.settings.glofox.
//      branch_id matches the payload's branchId).
//   3. Verify the HMAC-SHA256 signature against THAT location's
//      webhook_secret. Wrong/missing → 401.
//   4. Record in glofox_webhook_events for idempotency + audit. The
//      event_id UNIQUE constraint dedupes retried deliveries.
//   5. Find the matching CRM contact by email, scoped to the
//      resolved location.
//   6. Apply the mapped CRM tags (event type → tag list) and fire
//      any tag_added sequences listening for them.
//
// Auth is per-location: each Glofox branch can have its own
// webhook secret stored on its CRM location row. Lets multi-
// location operators rotate one secret without touching others.
//
// Dark-launch: GLOFOX_DARK_LAUNCH='true' (the only env var we
// keep) skips steps 5 + 6 — verify, audit, return 200. Lets us
// see real payload shapes before wiring action paths.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import {
  verifyGlofoxSignature,
  parseGlofoxEvent,
  tagsForGlofoxEvent,
  glofoxCredentialsByBranchId,
} from '@/lib/glofox'
import { triggerSequencesForTagsAdded } from '@/lib/sequences/triggers'
import { applyInvoiceWebhook } from '@/lib/glofox-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SIGNATURE_HEADER_CANDIDATES = [
  'signature',
  'x-glofox-signature',
  'x-signature',
]

function getSignatureHeader(request) {
  for (const name of SIGNATURE_HEADER_CANDIDATES) {
    const v = request.headers.get(name)
    if (v) return v
  }
  return null
}

export async function POST(request) {
  // Read raw body BEFORE parsing — HMAC must compute over the
  // bytes Glofox sent, not a re-stringified copy.
  const rawBody = await request.text()
  const signature = getSignatureHeader(request)

  // Parse once for branch_id lookup. JSON errors → 200 with
  // status='invalid_json' (Glofox wouldn't be able to retry into
  // success anyway).
  let payload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch (e) {
    logWarn('glofox-webhook', 'invalid JSON body', { err: e?.message })
    return NextResponse.json({ success: true, status: 'invalid_json' })
  }
  const parsed = parseGlofoxEvent(payload)

  const db = createServerClient()

  // 1. Look up the location's credentials by branch_id. No
  // branch_id in the payload OR no matching location → 401 (we
  // don't acknowledge events for unknown branches).
  if (!parsed.branchId) {
    logWarn('glofox-webhook', 'no branch_id in payload')
    return NextResponse.json({ success: false, error: 'Missing branch_id' }, { status: 400 })
  }
  const creds = await glofoxCredentialsByBranchId(db, parsed.branchId)
  if (!creds) {
    logWarn('glofox-webhook', 'unknown branch_id', { branch_id: parsed.branchId })
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Verify signature against THIS location's webhook secret.
  // Failing closed when the secret isn't set — operator must
  // paste it in Settings → Locations → Glofox Integration before
  // events are accepted.
  if (!creds.webhookSecret) {
    logWarn('glofox-webhook', 'webhook_secret not configured for branch', {
      branch_id: parsed.branchId, location_id: creds.locationId,
    })
    return NextResponse.json({ success: false, error: 'Webhook secret not configured' }, { status: 500 })
  }
  if (!verifyGlofoxSignature({ rawBody, signatureHeader: signature, secret: creds.webhookSecret })) {
    logWarn('glofox-webhook', 'signature verification failed', {
      branch_id: parsed.branchId, location_id: creds.locationId,
      hasSignature: !!signature, bodyLength: rawBody?.length || 0,
    })
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 3. Insert / upsert the event row (idempotency boundary). When
  // event_id is null Glofox didn't include one — we still record
  // for debug, just skip the dedupe.
  let eventRow
  if (parsed.eventId) {
    const { data, error } = await db
      .from('glofox_webhook_events')
      .upsert({
        event_id: parsed.eventId,
        event_type: parsed.eventType,
        branch_id: parsed.branchId,
        entity_id: parsed.entityId,
        contact_email: parsed.contactEmail,
        payload,
        signature,
        status: 'received',
      }, { onConflict: 'event_id', ignoreDuplicates: false })
      .select()
      .single()
    if (error) {
      logWarn('glofox-webhook', 'event row upsert failed', { err: error.message, event_id: parsed.eventId })
      return NextResponse.json({ success: true, status: 'audit_failed' })
    }
    eventRow = data
    if (eventRow.status && eventRow.status !== 'received') {
      return NextResponse.json({ success: true, status: 'deduped', existing_status: eventRow.status })
    }
  } else {
    const { data, error } = await db
      .from('glofox_webhook_events')
      .insert({
        event_id: null,
        event_type: parsed.eventType,
        branch_id: parsed.branchId,
        entity_id: parsed.entityId,
        contact_email: parsed.contactEmail,
        payload,
        signature,
        status: 'received',
      })
      .select()
      .single()
    if (error) {
      logWarn('glofox-webhook', 'event row insert failed', { err: error.message })
      return NextResponse.json({ success: true, status: 'audit_failed' })
    }
    eventRow = data
  }

  // 4. Dark-launch short-circuit. Verify + record, no action.
  if (process.env.GLOFOX_DARK_LAUNCH === 'true') {
    return NextResponse.json({ success: true, status: 'dark_launch', event_row_id: eventRow.id })
  }

  // 5. Map event type → tag list. Unknown events get marked but
  // not failed — Glofox might send domains we haven't mapped yet.
  const tags = tagsForGlofoxEvent(parsed.eventType)
  if (tags.length === 0) {
    await markEvent(db, eventRow.id, 'unknown_event_type', null, null)
    return NextResponse.json({ success: true, status: 'unknown_event_type', event_type: parsed.eventType })
  }

  // 6. Find the contact, scoped to the resolved location.
  if (!parsed.contactEmail) {
    await markEvent(db, eventRow.id, 'failed', null, 'No contact_email in payload')
    return NextResponse.json({ success: true, status: 'no_email' })
  }

  const { data: contactRows, error: contactErr } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', creds.locationId)
    .eq('email', parsed.contactEmail)
    .limit(1)
  if (contactErr) {
    await markEvent(db, eventRow.id, 'failed', null, `Contact lookup: ${contactErr.message}`)
    return NextResponse.json({ success: true, status: 'lookup_error' })
  }
  const contact = contactRows?.[0]
  if (!contact) {
    await markEvent(db, eventRow.id, 'contact_not_found', null, null)
    return NextResponse.json({ success: true, status: 'contact_not_found', email: parsed.contactEmail })
  }

  // 7a. GLOFOX2.1.20 — INVOICE_UPDATED side-effect. Mirror the
  // Glofox invoice into glofox_invoices + recompute the contact's
  // LTV aggregates. Best-effort: failures here log but don't abort
  // the rest of the webhook flow (tags + sequences still fire).
  let ltvResult = null
  const isInvoiceEvent = String(parsed.eventType || '').toUpperCase() === 'INVOICE_UPDATED'
  if (isInvoiceEvent) {
    try {
      ltvResult = await applyInvoiceWebhook(db, creds.locationId, contact.id, payload)
    } catch (e) {
      logWarn('glofox-webhook', 'invoice ltv update threw', {
        err: e?.message, contact_id: contact.id, event_id: parsed.eventId,
      })
      ltvResult = { ok: false, reason: 'threw', error: e?.message }
    }
  }

  // 7. Apply each tag using the same re-activate-or-insert pattern
  // as the apply_tag step in steps.js.
  const appliedTags = []
  for (const tag of tags) {
    try {
      const { data: existing } = await db
        .from('contact_tags')
        .select('id, removed_at')
        .eq('contact_id', contact.id)
        .eq('tag', tag)
        .order('added_at', { ascending: false })
        .limit(1)
      const row = existing?.[0]
      if (row && row.removed_at) {
        await db.from('contact_tags')
          .update({ removed_at: null, added_at: new Date().toISOString() })
          .eq('id', row.id)
      } else if (!row) {
        await db.from('contact_tags').insert({
          contact_id: contact.id,
          location_id: creds.locationId,
          tag,
        })
      }
      appliedTags.push(tag)
    } catch (e) {
      logWarn('glofox-webhook', `failed to apply tag ${tag}`, { err: e?.message, contact_id: contact.id })
    }
  }

  // 8. Fire tag_added sequences. Best-effort.
  if (appliedTags.length > 0) {
    try {
      await triggerSequencesForTagsAdded(contact.id, appliedTags)
    } catch (e) {
      logWarn('glofox-webhook', 'tag_added trigger threw', { err: e?.message })
    }
  }

  await markEvent(db, eventRow.id, 'applied', {
    contact_id: contact.id, tags: appliedTags, ltv: ltvResult,
  }, null)
  return NextResponse.json({
    success: true,
    status: 'applied',
    location_id: creds.locationId,
    contact_id: contact.id,
    tags: appliedTags,
    ltv: ltvResult,
  })
}

async function markEvent(db, id, status, result, errorMessage) {
  try {
    await db
      .from('glofox_webhook_events')
      .update({
        status,
        result,
        error_message: errorMessage,
        processed_at: new Date().toISOString(),
      })
      .eq('id', id)
  } catch {
    // Audit-update failure must not 500 the webhook.
  }
}
