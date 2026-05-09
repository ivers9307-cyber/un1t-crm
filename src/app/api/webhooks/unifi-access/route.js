// POST /api/webhooks/unifi-access
//
// Receives door-unlock events from UniFi Access and turns them into
// staff arrival stamps. Phase 1 of the zero-touch attendance feature.
//
// Wire-up
// -------
// In each location's UniFi Access controller:
//   Settings → System → Alarms → Add
//   Trigger: Door Unlocked, All Users, All Methods
//   Action: Webhook
//   URL:     https://crm.un1tdublin.com/api/webhooks/unifi-access
//   Header:  X-Webhook-Token: <UNIFI_ACCESS_WEBHOOK_TOKEN>
//
// Payload shape (firmware ~v3.x, observed live 2026-05-09)
// --------------------------------------------------------
// UniFi sends an alarm envelope, NOT a flat event:
//   {
//     alarm_id: "019e0da5-...",
//     events: [{
//       id: "access.entry.granted" | "access.unlocks.location_unlocked" | ...
//       user: "<uuid>",          // actor — links to profile_locations.unifi_user_id
//       device: "<uuid>" | "",   // door (empty when method is Remote Unlock)
//       location: "<uuid>",      // UniFi internal location id (NOT our location_id)
//       scope: { locations: "<uuid>" },
//       time: "<iso>" | "",
//       unlock_method_text: "NFC" | "Remote Unlock" | "PIN" | "REX" | "Touch to Unlock"
//     }],
//     data: { custom_content: "" }
//   }
//
// The alarm can contain multiple events; we iterate. Each event gets
// its own dedup key (alarm_id + index) and its own audit row.
//
// What counts as an arrival
// -------------------------
// We stamp shifts only when an event represents a physical presence
// at the door — i.e. unlock_method_text is something like NFC, PIN,
// REX, Touch to Unlock, or Mobile NFC. Remote Unlock (operator
// pressing unlock in the UniFi app or our /studio-management UI) is
// recorded for audit but never stamped — the actor is the operator,
// not the person walking through.
//
// Auth: shared secret in X-Webhook-Token, same pattern as Postmark.
// Token rotation supported via UNIFI_ACCESS_WEBHOOK_TOKEN_PREVIOUS.

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

// Regex matching UniFi event-id strings that represent a door
// unlock of any kind. Intentionally broad — we filter further
// downstream by unlock_method_text to separate real arrivals from
// remote app unlocks.
const UNLOCK_EVENT_RE = /access\.(entry|door|unlocks?)\.|door\.unlocked|entry\.(granted|success)/i

// unlock_method_text values that indicate a remote app / operator
// unlock — NOT a person walking through. We record them for audit
// (so staff_attendance_events still gets a row) but never stamp a
// shift from them.
const REMOTE_UNLOCK_METHODS = /^remote/i

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

  const payload = body || {}
  const alarmId = payload.alarm_id || payload.id || payload.uuid

  // Normalise into an events[] array. Newer firmware: payload.events
  // is the canonical place. Older firmware: the whole payload IS
  // a single event — wrap it.
  const events = Array.isArray(payload.events)
    ? payload.events
    : (payload.event_type || payload.event || payload.id) ? [payload] : []

  if (events.length === 0) {
    logInfo('webhook-unifi-access', 'no events in payload', { keys: Object.keys(payload).slice(0, 20) })
    return NextResponse.json({ success: true, ignored: 'no_events' })
  }

  const db = createServerClient()

  // ── Resolve which location this alarm belongs to ────────────
  // Single-UniFi-location deploy: just pick the only location with
  // UniFi configured. When we add a second location we'll need a
  // controller_id mapping (the `location` UUID inside each event
  // is UniFi's internal id, not ours).
  const { data: locs } = await db
    .from('locations')
    .select('id, name, timezone, settings')
    .not('settings->unifi', 'is', null)
  const candidateLocations = (locs || []).filter((l) => l.settings?.unifi?.host)
  const location = candidateLocations.length === 1 ? candidateLocations[0] : null
  if (!location) {
    logWarn('webhook-unifi-access', 'cannot resolve location (multi-tenant deploy needs controller mapping)', {
      candidates: candidateLocations.length,
    })
    return NextResponse.json({ success: true, ignored: 'unresolved_location' })
  }
  const locationId = location.id
  const locationTz = location.timezone || 'UTC'

  // ── Process each event in the alarm ─────────────────────────
  const results = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] || {}
    const eventType = String(ev.id || ev.type || ev.event || '')

    // Filter to unlock-family events only.
    if (!UNLOCK_EVENT_RE.test(eventType)) {
      results.push({ index: i, event_type: eventType, outcome: 'ignored_type' })
      continue
    }

    // Extract per-event fields.
    const actorUserId = ev.user || ev.actor?.id || ev.user_id || null
    const doorId      = ev.device || ev.door?.id || ev.door_id || null
    const methodText  = String(ev.unlock_method_text || '')
    const isRemote    = REMOTE_UNLOCK_METHODS.test(methodText)

    // Time can be empty in the payload for some methods. Fall back
    // to "now" — webhook latency from UniFi is ≤ 2s in practice.
    const eventAtRaw = ev.time || ev.timestamp || ev.occurred_at || null
    const eventAt = eventAtRaw ? new Date(eventAtRaw) : new Date()
    if (Number.isNaN(eventAt.getTime())) {
      results.push({ index: i, outcome: 'invalid_time' })
      continue
    }

    // Dedup key: alarm_id + index uniquely identifies one event in
    // one alarm fire. UniFi will retry the whole alarm on 5xx, so
    // dedup at this granularity is what we want.
    const dedupKey = alarmId ? `${alarmId}:${i}` : `synthetic:${eventAt.toISOString()}:${actorUserId || 'na'}:${i}`
    const dedup = await recordWebhookEvent({
      db,
      provider: WEBHOOK_PROVIDERS.UNIFI_ACCESS,
      eventId: dedupKey,
    })
    if (dedup.seen) {
      results.push({ index: i, outcome: 'deduped' })
      continue
    }

    // ── Resolve staff via profile_locations.unifi_user_id ────
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
        matchOutcome = isRemote ? 'no_shift_in_window' : 'no_shift_in_window'
      } else {
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

    // ── Stamp shift if this is a real arrival ────────────────
    // Remote unlocks are skipped here — the actor is the
    // operator who pressed unlock, not the person walking
    // through. Audit row still gets written below.
    if (profileId && !isRemote && matchOutcome === 'no_shift_in_window') {
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
          const scheduledAt    = resolveScheduledAt(r.block.block_date, r.block.start_time, locationTz)
          const scheduledEndAt = resolveScheduledAt(r.block.block_date, r.block.end_time,   locationTz)
          return scheduledAt ? { id: r.id, scheduledAt, scheduledEndAt, blockDate: r.block.block_date } : null
        })
        .filter(Boolean)

      const best = matchArrivalToShift(eventAt, shifts)
      if (best) {
        const stamp = arrivalToTimeOnly(eventAt, locationTz)
        const { error: updErr } = await db
          .from('shift_assignments')
          .update({ start_time_override: stamp })
          .eq('id', best.shift.id)
          .is('start_time_override', null)
        if (!updErr) {
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

    // If we never tried to stamp because the event was remote, label
    // the audit row distinctly so reports can filter on it.
    if (isRemote && profileId) {
      matchOutcome = 'no_shift_in_window'  // best-fit existing bucket; the payload tells the rest
    }

    // ── Always log the event for audit ───────────────────────
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
        payload: truncatePayload({
          alarm_id: alarmId,
          index: i,
          event_type: eventType,
          unlock_method_text: methodText,
          is_remote: isRemote,
          raw: ev,
        }, 8 * 1024),
      })
    if (insErr) {
      logWarn('webhook-unifi-access', 'audit insert failed', { err: insErr.message })
    } else {
      logInfo('webhook-unifi-access', 'event processed', {
        alarmId, index: i, eventType, methodText, isRemote,
        profileId, matchOutcome, matchedAssignmentId,
      })
    }

    results.push({
      index: i,
      event_type: eventType,
      method: methodText,
      is_remote: isRemote,
      outcome: matchOutcome,
      matched_assignment_id: matchedAssignmentId,
    })
  }

  return NextResponse.json({ success: true, alarm_id: alarmId, results })
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
