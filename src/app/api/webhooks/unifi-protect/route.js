// POST /api/webhooks/unifi-protect
//
// Phase 2 of zero-touch attendance: identifies staff arrivals via
// UniFi Protect face-recognition events. Co-equal with the Access
// receiver — whichever source's webhook lands first stamps the
// shift; the loser writes an `already_stamped` audit row pointing
// at the same matched_assignment_id. Useful for catching tailgates
// (Protect fires, Access didn't) and broken card readers (Protect
// covers the gap).
//
// DARK-LAUNCH NOTE
// ----------------
// As of mig 121 this receiver is intentionally minimal:
//   1. Authenticate on shared secret.
//   2. Resolve the location (single-Protect-location deploy for now).
//   3. Persist every event to staff_attendance_events with
//      source='protect' so we can inspect real payloads.
//   4. Log enough fields to derive the parser from observed traffic.
//
// We do NOT yet:
//   - Resolve face_id → profile_id (mig 123 adds the column;
//     mig 122 was consumed by the unrelated race_events.kind enum
//     before this work resumed — the next attendance mig is 123)
//   - Stamp shifts (P2.5 wires this once the payload shape is known)
//
// Every dark-launch event lands with match_outcome='unknown_user'
// by definition until mig 123 ships. This is the same play that
// worked for Access in Phase 1 — the docs lie often enough about
// the alarm-envelope shape that we'd rather build the parser
// against captured wire traffic than speculate.
//
// Wire-up
// -------
// In each location's UniFi Protect:
//   Settings → System → Alarm Manager → Add Alarm
//   Trigger: Smart Detection → Face Recognition (matched + unmatched)
//   Zone:    Entry-zone polygon drawn around the door interior
//            (otherwise it fires on people walking past on the street)
//   Action:  Webhook
//   URL:     https://crm.un1tdublin.com/api/webhooks/unifi-protect
//   Header:  X-Webhook-Token: <UNIFI_PROTECT_WEBHOOK_TOKEN>
//
// Auth: shared secret in X-Webhook-Token. Separate token from Access
// (different upstream system, independent rotation cadence).
// Token rotation supported via UNIFI_PROTECT_WEBHOOK_TOKEN_PREVIOUS.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADER_TOKEN = 'x-webhook-token'

/**
 * Pure auth-gate predicate, exported for the route test.
 * Mirrors verifyUnifiAccessRequest exactly so the test surface
 * stays consistent across the two receivers.
 */
export function verifyUnifiProtectRequest({ headerValue, primarySecret, previousSecret }) {
  if (!primarySecret) return { ok: false, status: 500, reason: 'missing_secret' }
  if (!headerValue)   return { ok: false, status: 403, reason: 'missing_header' }
  const primary = verifySharedSecret(headerValue, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }
  if (previousSecret) {
    const prev = verifySharedSecret(headerValue, previousSecret)
    if (prev.ok) return { ok: true, matched: 'previous' }
  }
  return { ok: false, status: 403, reason: 'token_mismatch' }
}

export async function POST(request) {
  // ── Auth ────────────────────────────────────────────────────
  const auth = verifyUnifiProtectRequest({
    headerValue: request.headers.get(HEADER_TOKEN),
    primarySecret: process.env.UNIFI_PROTECT_WEBHOOK_TOKEN,
    previousSecret: process.env.UNIFI_PROTECT_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      logWarn('webhook-unifi-protect', 'UNIFI_PROTECT_WEBHOOK_TOKEN not set — refusing with 500 so UniFi retries after fix')
    } else {
      logWarn('webhook-unifi-protect', 'rejected', { reason: auth.reason })
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    logWarn('webhook-unifi-protect', 'accepted via PREVIOUS token — finish rotating UniFi Protect webhook headers')
  }

  // ── Parse payload ───────────────────────────────────────────
  let body
  try { body = await request.json() }
  catch { return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 }) }

  const payload = body || {}
  const alarmId = payload.alarm_id || payload.id || payload.uuid

  // Normalise into events[]. Mirror the Access fallback shape:
  // newer firmware sends `events[]`, older firmware may send a
  // flat single-event payload — we wrap it.
  const events = Array.isArray(payload.events)
    ? payload.events
    : (payload.event_type || payload.event || payload.type || payload.id) ? [payload] : []

  if (events.length === 0) {
    logInfo('webhook-unifi-protect', 'no events in payload', {
      keys: Object.keys(payload).slice(0, 20),
    })
    return NextResponse.json({ success: true, ignored: 'no_events' })
  }

  const db = createServerClient()

  // ── Resolve which location this alarm belongs to ────────────
  // Single-Protect-location deploy for now (Stillorgan only). When
  // Hatch Street comes online we'll need a controller_id mapping
  // (the location UUID inside Protect events is the NVR's internal
  // id, not ours). We accept either settings.unifi_protect.host or
  // fall back to settings.unifi.host — the on-site setup tomorrow
  // will tell us which key the operator naturally reaches for.
  const { data: locs } = await db
    .from('locations')
    .select('id, name, timezone, settings')
    .or('settings->unifi.not.is.null,settings->unifi_protect.not.is.null')
  const candidateLocations = (locs || []).filter(
    (l) => l.settings?.unifi_protect?.host || l.settings?.unifi?.host
  )
  const location = candidateLocations.length === 1 ? candidateLocations[0] : null
  if (!location) {
    logWarn('webhook-unifi-protect', 'cannot resolve location (multi-Protect deploy needs controller mapping)', {
      candidates: candidateLocations.length,
    })
    return NextResponse.json({ success: true, ignored: 'unresolved_location' })
  }
  const locationId = location.id

  // ── Process each event in the alarm ─────────────────────────
  const results = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] || {}

    // The canonical event-type field on Protect alarms is unknown
    // until we see real traffic — speculate liberally so we capture
    // SOMETHING for the audit row, then narrow once we know.
    const eventType = String(
      ev.id || ev.type || ev.event || ev.smartDetectType ||
      ev.eventType || ev.modelKey || ''
    )

    // Best-effort time extraction. Protect commonly reports either:
    //   - start / end as epoch ms (most likely)
    //   - timestamp as epoch ms or ISO
    //   - time as ISO
    // Empty time (observed on Access remote unlocks) → fall back to
    // receipt time. Webhook latency is ≤ 2s in practice.
    const eventAtRaw = ev.start ?? ev.timestamp ?? ev.time ?? ev.occurred_at ?? null
    let eventAt
    if (typeof eventAtRaw === 'number')      eventAt = new Date(eventAtRaw)
    else if (typeof eventAtRaw === 'string' && eventAtRaw) eventAt = new Date(eventAtRaw)
    else                                     eventAt = new Date()
    if (Number.isNaN(eventAt.getTime()))     eventAt = new Date()

    // Dedup. Same alarm_id-reuse defense as Access (mig 120 header):
    // UniFi reuses alarm_id across every fire of an alarm rule, so
    // we mix in a 60-second receipt-time bucket. A retry-within-a-
    // minute dedupes; a fresh fire on the next minute boundary does
    // not. Worst case for double-fire within 60s is one missed audit
    // row — acceptable, and the future stamping race guard
    // (UPDATE … IS NULL) prevents double-stamping anyway.
    const minuteBucket = Math.floor(Date.now() / 60_000)
    const dedupKey = alarmId
      ? `${alarmId}:${i}:${minuteBucket}`
      : `synthetic:${eventAt.toISOString()}:${i}`
    const dedup = await recordWebhookEvent({
      db,
      provider: WEBHOOK_PROVIDERS.UNIFI_PROTECT,
      eventId: dedupKey,
    })
    if (dedup.seen) {
      results.push({ index: i, outcome: 'deduped' })
      continue
    }

    // ── Persist for inspection ──────────────────────────────
    // profile_id stays NULL until mig 123 lands the
    // protect_face_id mapping. unifi_door_id is overloaded for
    // Phase 2 to mean "camera id" (same column, similar semantics
    // — the device that observed the event); we'll rename or add
    // a sibling column if cohabitation gets messy.
    const cameraId = ev.camera || ev.device || ev.device_id || null

    const { error: insErr } = await db
      .from('staff_attendance_events')
      .insert({
        profile_id: null,
        location_id: locationId,
        source: 'protect',
        unifi_user_id: null,        // n/a until face↔profile mapping (mig 123)
        unifi_door_id: cameraId ? String(cameraId) : null,
        event_at: eventAt.toISOString(),
        matched_assignment_id: null,
        match_outcome: 'unknown_user',  // by definition during dark launch
        payload: truncatePayload({
          alarm_id: alarmId,
          index: i,
          event_type: eventType,
          raw: ev,
        }, 8 * 1024),
      })
    if (insErr) {
      logWarn('webhook-unifi-protect', 'audit insert failed', { err: insErr.message })
    } else {
      // Verbose log during dark-launch — we want the field names
      // visible in Vercel runtime logs so writing the parser is a
      // matter of "look at logs, see what's there, write the regex."
      logInfo('webhook-unifi-protect', 'event captured (dark launch)', {
        alarmId,
        index: i,
        eventType,
        cameraId,
        eventAt: eventAt.toISOString(),
        eventKeys: Object.keys(ev).slice(0, 30),
      })
    }

    results.push({
      index: i,
      event_type: eventType,
      outcome: 'captured',
    })
  }

  return NextResponse.json({ success: true, alarm_id: alarmId, results })
}

/**
 * Trim a JSON payload so a hostile / malformed sender can't blow
 * up our jsonb storage. Same util as the Access receiver — kept
 * inline to avoid a one-import shared file for now; if a third
 * receiver needs it we'll lift it to src/lib/webhook-payload.js.
 */
function truncatePayload(payload, maxBytes) {
  try {
    const json = JSON.stringify(payload)
    if (json.length <= maxBytes) return payload
    return { _truncated_raw: json.slice(0, maxBytes), _original_length: json.length }
  } catch {
    return { _serialisation_failed: true }
  }
}
