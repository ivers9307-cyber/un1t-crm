// POST /api/webhooks/unifi-access
//
// Receives door-unlock events from UniFi Access and turns them into
// staff arrival stamps. Phase 1 of the zero-touch attendance feature.
//
// Wire-up
// -------
// In each location's UniFi Access controller:
//   Settings → System → Webhooks → Add
//   URL:     https://crm.un1tdublin.com/api/webhooks/unifi-access
//   Events:  Door access (success only)
//   Header:  X-Webhook-Token: <UNIFI_ACCESS_WEBHOOK_TOKEN>
//
// The receiver fingerprints the door's location_id by looking up
// `locations.settings.unifi.host` matching the `controller_id` in
// the payload — so a single endpoint handles every studio.
//
// Auth: shared secret in X-Webhook-Token, same pattern as Postmark.
// Token rotation supported via UNIFI_ACCESS_WEBHOOK_TOKEN_PREVIOUS.
//
// Dedup: webhook_events (mig 107). The provider key is 'unifi_access'
// and event_id is the controller-supplied event UUID. Same retry
// behaviour as the other receivers — UniFi will retry 5xx so a
// transient DB hiccup doesn't lose the event.
//
// Match logic (src/lib/staff-attendance.js):
//   1. Resolve the staff: profile_locations.unifi_user_id at this
//      location matches the actor.user_id from the payload
//   2. Find candidate shifts: this profile, this location, today ±1d,
//      start_time_override IS NULL
//   3. Pick nearest within ±4h of the unlock event_at
//   4. Stamp shift_assignments.start_time_override = event_at in
//      the location's wall-clock time
//
// Always inserts a staff_attendance_events row for audit, even when
// no match is found — useful for debugging coverage gaps.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import {
  resolveScheduledAt,
  matchArrivalToShift,
  arrivalToTimeOnly,
} from '@/lib/staff-attendance'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADER_TOKEN = 'x-webhook-token'

/**
 * Pure auth-gate predicate, exported for the route test.
 */
export function verifyUnifiAccessRequest({ headerValue, primarySecret, previousSecret }) {
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
  const auth = verifyUnifiAccessRequest({
    headerValue: request.headers.get(HEADER_TOKEN),
    primarySecret: process.env.UNIFI_ACCESS_WEBHOOK_TOKEN,
    previousSecret: process.env.UNIFI_ACCESS_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      logWarn('webhook-unifi-access', 'UNIFI_ACCESS_WEBHOOK_TOKEN not set — refusing with 500 so UniFi retries after fix')
    } else {
      logWarn('webhook-unifi-access', 'rejected', { reason: auth.reason })
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    logWarn('webhook-unifi-access', 'accepted via PREVIOUS token — finish rotating UniFi webhook headers')
  }

  // ── Parse payload ───────────────────────────────────────────
  let body
  try { body = await request.json() }
  catch { return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 }) }

  // The payload shape has varied across UniFi Access firmware
  // versions. We accept either flat or nested envelope shapes and
  // pick the fields we care about defensively. If a key isn't
  // present we fall back to alternates.
  const payload = body || {}
  const eventId       = payload.event_id || payload.id || payload.uuid
  const eventTypeRaw  = payload.event || payload.type || payload.event_type || ''
  const eventAtRaw    = payload.event_at || payload.timestamp || payload.occurred_at || payload.created_at
  const actorUserId   = payload.actor?.id || payload.user?.id || payload.user_id || payload.actor_id
  const doorId        = payload.door?.id || payload.target?.id || payload.door_id
  const controllerId  = payload.controller_id || payload.controller || payload.host_id

  // Filter to door-access success events. UniFi Access fires events
  // for many things (door bell, lock-rule changes, user create,
  // etc); only door entries should drive attendance.
  const isDoorEntry = /access\.?(granted|success|allow)|door\.?(unlock|enter)|entry\.?(success|granted)/i.test(eventTypeRaw)
  if (!isDoorEntry) {
    // DIAGNOSTIC (temporary): record ignored events to the audit
    // table with source='unifi_access' + match_outcome='unknown_user'
    // so we can read the raw payload back from the DB to discover
    // what event-type string this UniFi firmware actually sends.
    // Once we've widened the regex this whole branch reverts to a
    // plain return.
    try {
      const db2 = createServerClient()
      // Pick a location to satisfy NOT NULL — first one with UniFi
      // configured, falls back to nothing (and we skip the insert).
      const { data: locs } = await db2
        .from('locations')
        .select('id, settings')
        .not('settings->unifi', 'is', null)
        .limit(1)
      const locId = (locs || [])[0]?.id
      if (locId) {
        await db2.from('staff_attendance_events').insert({
          location_id: locId,
          source: 'unifi_access',
          unifi_user_id: actorUserId ? String(actorUserId) : null,
          unifi_door_id: doorId ? String(doorId) : null,
          event_at: new Date().toISOString(),
          match_outcome: 'unknown_user',
          payload: truncatePayload({ _diag_ignored: true, event_type: eventTypeRaw, full: payload }, 8 * 1024),
        })
      }
    } catch (e) {
      logWarn('webhook-unifi-access', 'diag insert failed', { err: String(e) })
    }
    logInfo('webhook-unifi-access', 'ignored non-door-entry event', {
      event_type: eventTypeRaw,
      payload_keys: Object.keys(payload || {}).slice(0, 20),
    })
    return NextResponse.json({ success: true, ignored: 'not_a_door_entry', event_type: eventTypeRaw })
  }

  if (!eventId) {
    return NextResponse.json({ success: false, error: 'missing_event_id' }, { status: 400 })
  }

  const eventAt = eventAtRaw ? new Date(eventAtRaw) : new Date()
  if (Number.isNaN(eventAt.getTime())) {
    return NextResponse.json({ success: false, error: 'invalid_event_at' }, { status: 400 })
  }

  // ── Dedup ───────────────────────────────────────────────────
  const db = createServerClient()
  const dedup = await recordWebhookEvent({
    db,
    provider: WEBHOOK_PROVIDERS.UNIFI_ACCESS,
    eventId: String(eventId),
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // ── Resolve which location this controller belongs to ───────
  // We lookup by host fragment in locations.settings.unifi.host —
  // controller_id from the payload would be cleaner but isn't
  // available on every firmware. Match by sender if we can,
  // otherwise fall back to "any location with UniFi configured".
  // For Stillorgan-only deploy this is unambiguous; multi-location
  // we'll add a controller_id column on locations when needed.
  const { data: locs } = await db
    .from('locations')
    .select('id, name, timezone, settings')
    .not('settings->unifi', 'is', null)
  const candidateLocations = (locs || []).filter((l) => l.settings?.unifi?.host)
  // If the payload included a controller_id, prefer the location
  // whose stored controller_id matches.
  let location = null
  if (controllerId) {
    location = candidateLocations.find(
      (l) => l.settings?.unifi?.controller_id === controllerId
    ) || null
  }
  if (!location && candidateLocations.length === 1) {
    location = candidateLocations[0]    // single-location deploy
  }
  if (!location) {
    logWarn('webhook-unifi-access', 'could not resolve location for event', {
      controllerId, candidates: candidateLocations.length,
    })
    return NextResponse.json({ success: true, ignored: 'unresolved_location' })
  }
  const locationId = location.id
  const locationTz = location.timezone || 'UTC'

  // ── Resolve staff (profile_locations.unifi_user_id) ─────────
  let profileId = null
  let matchOutcome = 'unknown_user'
  let matchedAssignmentId = null

  if (actorUserId) {
    const { data: link } = await db
      .from('profile_locations')
      .select('profile_id, location_id, role')
      .eq('unifi_user_id', String(actorUserId))
      .eq('location_id', locationId)
      .maybeSingle()
    if (link) {
      profileId = link.profile_id
      matchOutcome = 'no_shift_in_window' // tentative; refined below
    } else {
      // The unifi_user_id exists at a different location? That's a
      // misroute — the staff member tapped at a door they're not
      // assigned to. Mark distinctly so it doesn't look like an
      // unknown member badge.
      const { data: anyLink } = await db
        .from('profile_locations')
        .select('profile_id')
        .eq('unifi_user_id', String(actorUserId))
        .maybeSingle()
      if (anyLink) {
        profileId = anyLink.profile_id
        matchOutcome = 'wrong_location'
      }
    }
  }

  // ── Find candidate shifts and pick the best match ───────────
  if (profileId && matchOutcome === 'no_shift_in_window') {
    // Today and yesterday's shifts at this location for this profile
    // that don't already have an arrival stamp.
    const dayBefore = new Date(eventAt.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
    const dayAfter  = new Date(eventAt.getTime() + 24 * 3600_000).toISOString().slice(0, 10)

    const { data: rows } = await db
      .from('shift_assignments')
      .select(`
        id, profile_id, status, start_time_override,
        block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time )
      `)
      .eq('profile_id', profileId)
      .is('start_time_override', null)
      .neq('status', 'cancelled')
      .gte('block.block_date', dayBefore)
      .lte('block.block_date', dayAfter)
      .eq('block.location_id', locationId)

    const shifts = (rows || [])
      .map((r) => {
        if (!r.block) return null
        const scheduledAt = resolveScheduledAt(r.block.block_date, r.block.start_time, locationTz)
        const scheduledEndAt = resolveScheduledAt(r.block.block_date, r.block.end_time, locationTz)
        return scheduledAt ? {
          id: r.id, scheduledAt, scheduledEndAt,
          blockDate: r.block.block_date,
        } : null
      })
      .filter(Boolean)

    const best = matchArrivalToShift(eventAt, shifts)
    if (best) {
      // Stamp the arrival as a wall-clock time in the location tz.
      const stamp = arrivalToTimeOnly(eventAt, locationTz)
      const { error: updErr } = await db
        .from('shift_assignments')
        .update({ start_time_override: stamp })
        .eq('id', best.shift.id)
        .is('start_time_override', null)   // race-safe: only stamp if still empty
      if (updErr) {
        logWarn('webhook-unifi-access', 'stamp failed', { assignmentId: best.shift.id, err: updErr })
        matchOutcome = 'no_shift_in_window'  // best diagnosable bucket
      } else {
        // Re-read to verify the stamp actually landed (it would not
        // if a parallel webhook beat us to it — the .is() filter
        // would silently no-op).
        const { data: post } = await db
          .from('shift_assignments')
          .select('start_time_override')
          .eq('id', best.shift.id)
          .single()
        if (post && post.start_time_override === stamp) {
          matchedAssignmentId = best.shift.id
          matchOutcome = 'matched'
        } else {
          matchOutcome = 'already_stamped'
        }
      }
    }
  }

  // ── Always log the event for audit ──────────────────────────
  const { error: insErr } = await db
    .from('staff_attendance_events')
    .insert({
      profile_id: profileId,
      location_id: locationId,
      source: 'unifi_access',
      unifi_user_id: actorUserId ? String(actorUserId) : null,
      unifi_door_id: doorId ? String(doorId) : null,
      event_at: eventAt.toISOString(),
      matched_assignment_id: matchedAssignmentId,
      match_outcome: matchOutcome,
      // Truncate raw payload — defensive against an unbounded
      // upstream blowing up our jsonb storage.
      payload: truncatePayload(payload, 8 * 1024),
    })
  if (insErr) {
    logWarn('webhook-unifi-access', 'audit insert failed', { err: insErr })
    // Don't 5xx — the stamp may already have happened. Acknowledge
    // the webhook so UniFi doesn't retry.
  } else {
    logInfo('webhook-unifi-access', 'event processed', {
      profileId, locationId, eventAt: eventAt.toISOString(),
      matchOutcome, matchedAssignmentId,
    })
  }

  return NextResponse.json({
    success: true,
    match_outcome: matchOutcome,
    matched_assignment_id: matchedAssignmentId,
  })
}

/**
 * Trim a JSON payload so a hostile / malformed sender can't blow
 * up our jsonb storage. Quick + dirty: serialise, slice, return as
 * an object containing the truncated string under `_truncated_raw`
 * if it's too big to keep as parsed JSON.
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
