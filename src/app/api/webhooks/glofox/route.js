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
//      resolved location. MEMBER_CREATED for an unknown member
//      CREATES the contact in real time (single-member fetch +
//      applyMemberSync) and fires contact_created sequences
//      (SEQ-GLOFOX.1) — the nightly bulk sync stays excluded from
//      that trigger (mass-create guard).
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
  glofoxFetch,
} from '@/lib/glofox'
import {
  triggerSequencesForTagsAdded,
  triggerSequencesForContactCreated,
  triggerSequencesForMembershipStateChange,
} from '@/lib/sequences/triggers'
import { applyInvoiceWebhook } from '@/lib/glofox-invoices'
import { applyServiceWebhook } from '@/lib/glofox-services'
import { applyMembershipPauseWindow } from '@/lib/glofox-membership'
import { maybeEnrolDunning, exitDunningForContact, dunningActionFor } from '@/lib/dunning'
import { applyMemberSync } from '@/lib/glofox-sync'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'

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
  const db = createServerClient()

  // GLOFOX-ROBUST — strip NUL bytes before parsing/storing. Postgres
  // jsonb rejects the NUL character, which silently fails the audit
  // payload types that contain them (observed: SERVICE_* deliveries
  // 200'd with no recorded row — a silently-dropped webhook). The HMAC
  // is still verified against the ORIGINAL bytes below.
  const bodyForParse = typeof rawBody === 'string' ? rawBody.replace(/\u0000/g, '') : rawBody

  // Parse once for branch_id lookup. On failure we do NOT silently drop
  // the delivery — dead-letter the raw body so it's visible + replayable.
  let payload
  try {
    payload = bodyForParse ? JSON.parse(bodyForParse) : {}
  } catch (e) {
    logWarn('glofox-webhook', 'invalid JSON body', { err: e?.message })
    await deadLetterWebhook(db, {
      provider: 'glofox',
      eventType: null,
      payload: {
        _unparsed_raw_body: (bodyForParse || '').slice(0, 8000),
        _content_type: request.headers.get('content-type') || null,
      },
      error: e,
    })
    return NextResponse.json({ success: true, status: 'invalid_json' })
  }
  const parsed = parseGlofoxEvent(payload)

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
      await deadLetterWebhook(db, { provider: 'glofox', eventType: parsed.eventType, payload, error, locationId: creds.locationId })
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
      await deadLetterWebhook(db, { provider: 'glofox', eventType: parsed.eventType, payload, error, locationId: creds.locationId })
      return NextResponse.json({ success: true, status: 'audit_failed' })
    }
    eventRow = data
  }

  // 4. Dark-launch short-circuit. Verify + record, no action.
  if (process.env.GLOFOX_DARK_LAUNCH === 'true') {
    return NextResponse.json({ success: true, status: 'dark_launch', event_row_id: eventRow.id })
  }

  // 5–9. Action block — everything AFTER auth + dedup + dark-launch is the
  // "processing" boundary. If anything here throws unexpectedly (a bug, a
  // transient lib error, etc.) we capture a dead-letter row and still 200 the
  // provider. The inner try/catch blocks below (invoice, tag, sequences,
  // member-sync) are best-effort guards for known failure modes; this outer
  // catch is the safety net for anything else.
  try {
    // 5. Map event type → tag list. Unknown events get marked but
    // not failed — Glofox might send domains we haven't mapped yet.
    const tags = tagsForGlofoxEvent(parsed.eventType)
    if (tags.length === 0) {
      await markEvent(db, eventRow.id, 'unknown_event_type', null, null)
      return NextResponse.json({ success: true, status: 'unknown_event_type', event_type: parsed.eventType })
    }

    // 6. Find the contact, scoped to the resolved location.
    // Lookup priority:
    //   a) email — preferred (MEMBER_UPDATED, INVOICE_UPDATED)
    //   b) glofox_member_id — fallback for BOOKING_* / MEMBERSHIP_*
    //      events which Glofox's payloads ship without an email
    //      (GLOFOX5.1).
    if (!parsed.contactEmail && !parsed.userId) {
      await markEvent(db, eventRow.id, 'failed', null, 'No contact_email or user_id in payload')
      return NextResponse.json({ success: true, status: 'no_email' })
    }

    let contact = null
    if (parsed.contactEmail) {
      const { data: contactRows, error: contactErr } = await db
        .from('contacts')
        .select('id, last_booked_at')
        .eq('location_id', creds.locationId)
        .eq('email', parsed.contactEmail)
        .limit(1)
      if (contactErr) {
        await markEvent(db, eventRow.id, 'failed', null, `Contact lookup by email: ${contactErr.message}`)
        return NextResponse.json({ success: true, status: 'lookup_error' })
      }
      contact = contactRows?.[0] || null
    }
    if (!contact && parsed.userId) {
      const { data: contactRows, error: contactErr } = await db
        .from('contacts')
        .select('id, last_booked_at')
        .eq('location_id', creds.locationId)
        .eq('glofox_member_id', parsed.userId)
        .limit(1)
      if (contactErr) {
        await markEvent(db, eventRow.id, 'failed', null, `Contact lookup by glofox_member_id: ${contactErr.message}`)
        return NextResponse.json({ success: true, status: 'lookup_error' })
      }
      contact = contactRows?.[0] || null
    }
    // 6b. SEQ-GLOFOX.1 — real-time contact creation for brand-new Glofox
    // leads/members. MEMBER_CREATED for a contact we don't know used to
    // dead-end as contact_not_found: the webhook never creates, and the
    // nightly 3am bulk sync (which would eventually create the row)
    // deliberately does NOT fire contact_created sequences (mass-create
    // guard). Net effect: "new lead created in Glofox" automations never
    // fired. This path is per-event (one member per webhook), so the
    // mass-create concern doesn't apply: fetch the canonical member,
    // create through the shared sync write-path, and fire contact_created
    // ONLY on a genuine insert — applyMemberSync returning 'update' means
    // it matched an existing contact (e.g. same email), not a new person.
    let memberSyncResult = null
    const evUpper = String(parsed.eventType || '').toUpperCase().replace(/[.\-]/g, '_')
    if (!contact && parsed.userId && evUpper === 'MEMBER_CREATED') {
      try {
        const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(parsed.userId)}`)
        if (r.ok) {
          const body = await r.json()
          const fullMember = body?.data || body?.member || body
          memberSyncResult = await applyMemberSync(db, creds.locationId, fullMember, { creds })
          if (memberSyncResult?.contact_id) {
            contact = { id: memberSyncResult.contact_id }
            if (memberSyncResult.action === 'create') {
              try {
                await triggerSequencesForContactCreated(memberSyncResult.contact_id)
              } catch (e) {
                logWarn('glofox-webhook', 'contact_created trigger threw', { err: e?.message, contact_id: memberSyncResult.contact_id })
              }
            }
          }
        } else {
          memberSyncResult = { ok: false, status: r.status, reason: 'glofox_fetch_failed' }
        }
      } catch (e) {
        logWarn('glofox-webhook', 'lead-create member sync threw', { err: e?.message, user_id: parsed.userId })
        memberSyncResult = { ok: false, reason: 'threw', error: e?.message }
      }
    }

    if (!contact) {
      await markEvent(db, eventRow.id, 'contact_not_found', null, null)
      return NextResponse.json({
        success: true,
        status: 'contact_not_found',
        email: parsed.contactEmail,
        user_id: parsed.userId,
      })
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

    // 7b. GLOFOX-REACTIVE / DUNNING.1 — event-driven dunning off the invoice
    // status, MEMBERSHIP invoices only (the churn radar's Overdue category).
    // PAST_DUE → enrol into the location's dunning sequence (opt-in via
    // locations.dunning_auto_enroll; paused members skipped; idempotent so a
    // retry storm collapses to one enrolment). PAID / FORGIVEN → stop any
    // in-flight dunning. A fee / class pack / custom charge never starts OR
    // stops a run — dunningActionFor returns null for those.
    // Best-effort: the helpers never throw, but guard anyway.
    let dunningResult = null
    if (isInvoiceEvent && ltvResult?.ok) {
      const invStatus = String(ltvResult.invoice_status || '').toUpperCase()
      const action = dunningActionFor(invStatus, ltvResult.is_membership)
      try {
        if (action === 'enrol') {
          dunningResult = await maybeEnrolDunning(db, creds.locationId, contact.id, { invoiceId: ltvResult.invoice_id, isMembership: true })
        } else if (action === 'exit') {
          dunningResult = await exitDunningForContact(db, creds.locationId, contact.id, `invoice_${invStatus.toLowerCase()}`)
        }
      } catch (e) {
        logWarn('glofox-webhook', 'reactive dunning threw', { err: e?.message, contact_id: contact.id })
      }
    }

    // 7c. GLOFOX-REACTIVE — SERVICE_* pause capture. Persist the pause
    // window (start / duration / resume_date — the only Glofox surface
    // that carries it) + denormalise onto the contact. On a real state
    // flip, fire membership_state_change sequences; when it flips to
    // paused, suppress any in-flight dunning (never dun a paused member).
    let serviceResult = null
    const isServiceEvent = evUpper === 'SERVICE_CREATED' || evUpper === 'SERVICE_UPDATED' || evUpper === 'SERVICE_DELETED'
    if (isServiceEvent) {
      try {
        serviceResult = await applyServiceWebhook(db, creds.locationId, contact.id, payload)
        const flip = serviceResult?.state_change
        if (flip) {
          try {
            await triggerSequencesForMembershipStateChange(contact.id, flip.from, flip.to)
          } catch (e) {
            logWarn('glofox-webhook', 'membership_state_change trigger threw', { err: e?.message, contact_id: contact.id })
          }
          if (flip.to === 'paused') {
            try {
              await exitDunningForContact(db, creds.locationId, contact.id, 'membership_paused')
            } catch (e) {
              logWarn('glofox-webhook', 'pause dunning-suppress threw', { err: e?.message, contact_id: contact.id })
            }
          }
        }
      } catch (e) {
        logWarn('glofox-webhook', 'service webhook threw', {
          err: e?.message, contact_id: contact.id, event_id: parsed.eventId,
        })
        serviceResult = { ok: false, reason: 'threw', error: e?.message }
      }
    }

    // 6c. SEQ-GLOFOX.2 — stamp glofox_first_booking once-ever on the first
    // booking we see for a contact. The flow builder's "has booked their
    // first class?" branch keys on this tag. Two guards keep it honest:
    //   - once-ever: if a contact_tags row has EVER existed (even removed
    //     by an operator), a first booking can't happen twice — we skip;
    //   - last_booked_at must be empty: long-standing members predate this
    //     tag (no backfill BY DESIGN — a backfill would mass-fire
    //     tag_added sequences), so without this guard a veteran's next
    //     booking would wrongly stamp "first". At this point in the
    //     request last_booked_at still holds the value from BEFORE this
    //     booking (step 9's member sync updates it afterwards).
    // Adding to `tags` here rides the step-7 apply loop + step-8
    // tag_added triggers, so "first booking" automations work too.
    if ((evUpper === 'BOOKING_CREATED' || evUpper === 'COURSE_BOOKING_CREATED') && !contact.last_booked_at) {
      try {
        const { data: fbRows } = await db
          .from('contact_tags')
          .select('id')
          .eq('contact_id', contact.id)
          .eq('tag', 'glofox_first_booking')
          .limit(1)
        if (!fbRows?.length) tags.push('glofox_first_booking')
      } catch (e) {
        logWarn('glofox-webhook', 'first-booking tag check threw', { err: e?.message, contact_id: contact.id })
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

    // 9. GLOFOX5.1 — real-time member sync for state-changing events.
    // applyMemberSync detects trial-lifecycle transitions and writes
    // glofox_trial_engaged / _credits_low / _ended / _converted tags
    // (GLOFOX4.2). Without this, those tags only fired from the daily
    // 3am cron — a 24-hour delay between an actual class booking and
    // the operator-built sequences reacting to it.
    //
    // We re-fetch from /2.0/members/{id} rather than trust the webhook
    // payload because:
    //   - BOOKING events don't include the member's lead_status
    //   - MEMBERSHIP events don't include the booking aggregates
    //   - applyMemberSync needs the canonical member shape to compute
    //     credits + booking counts correctly
    // Best-effort: failures here log but don't fail the webhook.
    const MEMBER_SYNC_EVENTS = new Set([
      'MEMBER_UPDATED', 'MEMBER_CREATED',
      'BOOKING_CREATED', 'BOOKING_UPDATED', 'BOOKING_DELETED',
      'MEMBERSHIP_CREATED', 'MEMBERSHIP_UPDATED', 'MEMBERSHIP_DELETED',
      'COURSE_BOOKING_CREATED', 'COURSE_BOOKING_DELETED',
    ])
    // `!memberSyncResult` — 6b already fetched + synced this exact member
    // when it created the contact; don't do it twice in one delivery.
    if (!memberSyncResult && parsed.userId && MEMBER_SYNC_EVENTS.has(evUpper)) {
      try {
        const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(parsed.userId)}`)
        if (r.ok) {
          const body = await r.json()
          const fullMember = body?.data || body?.member || body
          memberSyncResult = await applyMemberSync(db, creds.locationId, fullMember, { creds })
        } else {
          memberSyncResult = { ok: false, status: r.status, reason: 'glofox_fetch_failed' }
        }
      } catch (e) {
        logWarn('glofox-webhook', 'real-time member sync threw', {
          err: e?.message, user_id: parsed.userId, event_type: parsed.eventType,
        })
        memberSyncResult = { ok: false, reason: 'threw', error: e?.message }
      }
    }

    // 10. GLOFOX-REACTIVE — membership pause WINDOW. Glofox delivers a
    // pause as MEMBERSHIP_UPDATED (status=PAUSED, cycle.start_date =
    // resume date), NOT a service event. Runs AFTER the member sync so
    // glofox_membership_state is current for the multi-membership guard
    // (an active membership's event must not wipe another's live pause).
    let membershipPauseResult = null
    if (evUpper === 'MEMBERSHIP_CREATED' || evUpper === 'MEMBERSHIP_UPDATED' || evUpper === 'MEMBERSHIP_DELETED') {
      try {
        membershipPauseResult = await applyMembershipPauseWindow(db, contact.id, payload)
      } catch (e) {
        logWarn('glofox-webhook', 'membership pause window threw', { err: e?.message, contact_id: contact.id })
      }
    }

    await markEvent(db, eventRow.id, 'applied', {
      contact_id: contact.id, tags: appliedTags, ltv: ltvResult,
      service: serviceResult, membership_pause: membershipPauseResult,
      dunning: dunningResult, member_sync: memberSyncResult,
    }, null)
    return NextResponse.json({
      success: true,
      status: 'applied',
      location_id: creds.locationId,
      contact_id: contact.id,
      tags: appliedTags,
      ltv: ltvResult,
      service: serviceResult,
      membership_pause: membershipPauseResult,
      dunning: dunningResult,
      member_sync: memberSyncResult ? { applied: memberSyncResult.action || memberSyncResult.ok || false } : null,
    })
  } catch (e) {
    logWarn('glofox-webhook', 'processing threw unexpectedly', {
      err: e?.message, event_type: parsed.eventType, event_id: parsed.eventId,
    })
    await deadLetterWebhook(db, {
      provider: 'glofox',
      eventType: parsed.eventType || null,
      payload,
      error: e,
      locationId: creds.locationId,
    })
    // Always 200 Glofox — we have the raw payload in dead_letter for replay.
    return NextResponse.json({ success: true, status: 'processing_failed_dead_lettered' })
  }
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
