// /api/webhooks/glofox — inbound receiver for Glofox webhooks
// (GLOFOX1).
//
// Glofox POSTs JSON for booking / membership / member / access
// events. We:
//   1. Verify the HMAC-SHA256 signature header against
//      GLOFOX_WEBHOOK_SECRET. Mismatch → 401, no body.
//   2. Record the event in glofox_webhook_events (mig 132). The
//      event_id UNIQUE constraint is the idempotency boundary —
//      a duplicate delivery hits the dedupe path and returns 200
//      without re-processing.
//   3. Look up the matching CRM contact by email (scoped to the
//      configured Glofox-mapped location).
//   4. Apply the mapped CRM tags via contact_tags + fire any
//      sequence with trigger_type='tag_added' listening for them.
//   5. Update the event row with status + result. Always 200 to
//      Glofox after auth so they don't retry on our internal
//      issues (we have the audit row to retry from).
//
// Dark-launch:
//   When GLOFOX_DARK_LAUNCH='true', steps 3 + 4 are skipped — we
//   verify, record, and return 200 with status='received'. Lets
//   us see real payload shapes before wiring action paths,
//   exactly like UniFi Protect P2.1 did. Flip the env to 'false'
//   (or remove it) to go live.
//
// Configuration (env):
//   GLOFOX_WEBHOOK_SECRET — required, HMAC-SHA256 signing secret
//                           that Glofox provides separately when
//                           webhooks are enabled.
//   GLOFOX_BRANCH_ID      — operator's Glofox branch (one per
//                           location today).
//   GLOFOX_LOCATION_ID    — uuid of the CRM location that
//                           GLOFOX_BRANCH_ID maps to. Future:
//                           per-branch table; today single-loc.
//   GLOFOX_DARK_LAUNCH    — 'true' to skip step 3+4. Default:
//                           false (full processing).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import {
  verifyGlofoxSignature,
  parseGlofoxEvent,
  tagsForGlofoxEvent,
} from '@/lib/glofox'
import { triggerSequencesForTagsAdded } from '@/lib/sequences/triggers'

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
  const secret = process.env.GLOFOX_WEBHOOK_SECRET
  // Read the raw body BEFORE parsing — HMAC must be computed over
  // the bytes Glofox sent, not over a re-stringified copy that
  // might differ in whitespace / key order.
  const rawBody = await request.text()
  const signature = getSignatureHeader(request)

  // 1. Auth. Failing closed when the secret isn't configured — a
  // half-deployed env shouldn't accidentally accept unauthenticated
  // events.
  if (!secret) {
    logWarn('glofox-webhook', 'GLOFOX_WEBHOOK_SECRET not set; rejecting all webhooks')
    return NextResponse.json({ success: false, error: 'Server not configured' }, { status: 500 })
  }
  if (!verifyGlofoxSignature({ rawBody, signatureHeader: signature, secret })) {
    logWarn('glofox-webhook', 'signature verification failed', {
      hasSignature: !!signature,
      bodyLength: rawBody?.length || 0,
    })
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Parse + record. JSON parse errors get logged and return 200
  // so Glofox doesn't retry — invalid JSON is unrecoverable; we
  // want to know but not hold up their queue.
  let payload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch (e) {
    logWarn('glofox-webhook', 'invalid JSON body', { err: e?.message })
    return NextResponse.json({ success: true, status: 'invalid_json' })
  }

  const parsed = parseGlofoxEvent(payload)
  const db = createServerClient()

  // Insert the event row. ON CONFLICT (event_id) returns the existing
  // row so we can detect duplicates without a second roundtrip.
  // event_id can be null when Glofox didn't include one — those
  // skip the dedupe (always insert as a new row).
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
    // If status is anything other than 'received' on the existing
    // row, we've processed this event before — return 200 immediately.
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

  // 3. Dark-launch short-circuit. Verify + record, no action.
  if (process.env.GLOFOX_DARK_LAUNCH === 'true') {
    return NextResponse.json({ success: true, status: 'dark_launch', event_row_id: eventRow.id })
  }

  // 4. Map event type → tag list. Unknown events get marked but
  // not failed — Glofox might send domains we haven't mapped yet.
  const tags = tagsForGlofoxEvent(parsed.eventType)
  if (tags.length === 0) {
    await markEvent(db, eventRow.id, 'unknown_event_type', null, null)
    return NextResponse.json({ success: true, status: 'unknown_event_type', event_type: parsed.eventType })
  }

  // 5. Find the contact. Scoped to GLOFOX_LOCATION_ID so events
  // can't bleed across locations even if a member's email collides
  // between studios.
  const locationId = process.env.GLOFOX_LOCATION_ID
  if (!locationId) {
    await markEvent(db, eventRow.id, 'failed', null, 'GLOFOX_LOCATION_ID not configured')
    return NextResponse.json({ success: true, status: 'location_not_configured' })
  }
  if (!parsed.contactEmail) {
    await markEvent(db, eventRow.id, 'failed', null, 'No contact_email in payload')
    return NextResponse.json({ success: true, status: 'no_email' })
  }

  const { data: contactRows, error: contactErr } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', locationId)
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

  // 6. Apply each tag. contact_tags has a partial unique on
  // (contact_id, tag) WHERE removed_at IS NULL — re-applying an
  // active tag is a no-op via the upsert pattern from steps.js
  // (re-activate soft-deleted, otherwise insert).
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
          location_id: locationId,
          tag,
        })
      }
      appliedTags.push(tag)
    } catch (e) {
      logWarn('glofox-webhook', `failed to apply tag ${tag}`, { err: e?.message, contact_id: contact.id })
    }
  }

  // 7. Fire tag_added sequences. Best-effort — sequence trigger
  // failures must not fail the webhook. The triggers helper itself
  // swallows errors per the existing pattern.
  if (appliedTags.length > 0) {
    try {
      await triggerSequencesForTagsAdded(contact.id, appliedTags)
    } catch (e) {
      logWarn('glofox-webhook', 'tag_added trigger threw', { err: e?.message })
    }
  }

  await markEvent(db, eventRow.id, 'applied', { contact_id: contact.id, tags: appliedTags }, null)
  return NextResponse.json({
    success: true,
    status: 'applied',
    contact_id: contact.id,
    tags: appliedTags,
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
    // Audit-update failure must not 500 the webhook — the row
    // exists, we just couldn't transition status. Will appear as
    // 'received' in the audit table; debug from the payload.
  }
}
