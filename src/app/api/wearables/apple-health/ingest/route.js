// POST /api/wearables/apple-health/ingest
//
// Direct Apple Health ingest. The member's device reads HealthKit on-device and
// uploads a batch of workouts (+ HR samples + health metrics) here. Customer-
// authed via the member's Supabase JWT (resolveCustomerContact) — un1t-crm's
// proxy lets a valid member token through /api/*, and we resolve the contact
// from it (getCurrentUser resolves STAFF, not members).
//
// This REPLACES the OpenWearables relay + webhook for Apple Health: identical
// map → class-correlate → dedup → insert → finalise path as the old
// /api/webhooks/openwearables, minus the Svix signature + the OW fetch-back
// (the device already read the workout and sends it inline).
//
// Body:
//   {
//     workouts: [{ workout: <Workout-Output>, hrSamples: [{timestamp,value,unit?}] }],
//     healthMetrics: [{ metric, recorded_at, value, unit? }]
//   }
// Idempotent: workouts dedup on raw_metadata.apple_workout_uuid; metrics upsert
// on (contact_id, metric, recorded_at). Apple Health is NOT §5.4-restricted —
// these sessions earn points + feed community, same as a strap session.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { mapAppleHealthWorkoutToSession } from '@/lib/apple-health-map'
import { resolveMaxHr, resolveScoringConfig } from '@/lib/heart-rate'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { lookupBookedMember } from '@/lib/class-bookings'
import { finalizeSessionRewards } from '@/lib/live-class'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const db = createServerClient()

  const { contact, error } = await resolveCustomerContact(request, { db })
  if (error) {
    return NextResponse.json({ success: false, error }, { status: error === 'no_contact' ? 409 : 401 })
  }
  if (!contact.location_id) {
    return NextResponse.json({ success: false, error: 'no_location' }, { status: 409 })
  }
  const locationId = contact.location_id

  let body
  try { body = await request.json() } catch { body = {} }
  const workouts = Array.isArray(body?.workouts) ? body.workouts : []
  const healthMetrics = Array.isArray(body?.healthMetrics) ? body.healthMetrics : []

  const { data: location } = await db.from('locations').select('id, settings').eq('id', locationId).maybeSingle()
  const maxHr = resolveMaxHr(contact)
  const scoring = resolveScoringConfig(location)

  let ingested = 0
  let deduped = 0
  let finalised = 0

  for (const item of workouts) {
    const workout = item?.workout ?? item
    const hrSamples = Array.isArray(item?.hrSamples) ? item.hrSamples : []
    // Need the dedup key (HealthKit UUID) + a time anchor; skip anything without them.
    if (!workout?.id || !workout?.start_time) continue
    const appleUuid = String(workout.id)

    const session = mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr, scoring })
    session.contact_id = contact.id
    session.location_id = locationId

    // Class-correlate on the WORKOUT's start (an imported workout is historical).
    const workoutStartMs = Date.parse(workout.start_time)
    if (Number.isFinite(workoutStartMs)) {
      const occ = await resolveCurrentOccurrence(db, { locationId, nowMs: workoutStartMs })
      if (occ?.glofox_event_id) {
        session.glofox_event_id = occ.glofox_event_id
        session.class_name = occ.class_name ?? null
        let booked = false
        try {
          const { data: c } = await db.from('contacts').select('glofox_member_id').eq('id', contact.id).maybeSingle()
          booked = await lookupBookedMember(db, {
            locationId,
            glofoxEventId: occ.glofox_event_id,
            glofoxMemberId: c?.glofox_member_id ?? null,
          })
        } catch (e) {
          console.warn(`[apple-health-ingest] booking lookup failed for contact ${contact.id}: ${e?.message || e}`)
        }
        session.class_link_source = booked ? 'booked' : null
      }
    }

    // Dedup (a): this exact workout already landed (re-upload / overlapping backfill).
    const { data: existing } = await db
      .from('heart_rate_sessions')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('source', 'apple_health')
      .filter('raw_metadata->>apple_workout_uuid', 'eq', appleUuid)
      .limit(1)
      .maybeSingle()
    if (existing?.id) { deduped++; continue }

    // Dedup (b): a richer (strap) session already owns this class slot.
    if (session.glofox_event_id) {
      const { data: richer } = await db
        .from('heart_rate_sessions')
        .select('id, source')
        .eq('contact_id', contact.id)
        .eq('glofox_event_id', session.glofox_event_id)
        .neq('source', 'apple_health')
        .limit(1)
        .maybeSingle()
      if (richer?.id) { deduped++; continue }
    }

    const { data: inserted, error: insErr } = await db
      .from('heart_rate_sessions')
      .insert(session)
      .select('id')
      .single()
    if (insErr || !inserted) {
      console.warn(`[apple-health-ingest] insert failed for workout ${appleUuid}: ${insErr?.message}`)
      continue
    }
    ingested++

    // Best-effort reward cascade (IB3 made it import-safe). Never block the response.
    try {
      await finalizeSessionRewards(db, inserted.id, { nowMs: Date.now() })
      finalised++
    } catch (e) {
      console.warn(`[apple-health-ingest] finalizeSessionRewards threw for ${inserted.id}: ${e?.message || e}`)
    }
  }

  // Health metrics → member_health_metrics (resting HR / HRV / VO2max / active
  // energy → the Progress "Recovery & fitness" trends). Dedup on the unique
  // (contact_id, metric, recorded_at). source is NOT NULL → 'apple_health'.
  let metricsUpserted = 0
  const metricRows = healthMetrics
    .filter((m) => m?.metric && m?.recorded_at && m?.value != null && Number.isFinite(Number(m.value)))
    .map((m) => ({
      contact_id: contact.id,
      location_id: locationId,
      metric: String(m.metric),
      recorded_at: m.recorded_at,
      value: Number(m.value),
      unit: m.unit ?? null,
      source: 'apple_health',
    }))
  if (metricRows.length > 0) {
    const { error: mErr } = await db
      .from('member_health_metrics')
      .upsert(metricRows, { onConflict: 'contact_id,metric,recorded_at' })
    if (mErr) {
      console.warn(`[apple-health-ingest] health-metrics upsert failed for contact ${contact.id}: ${mErr.message}`)
    } else {
      metricsUpserted = metricRows.length
    }
  }

  return NextResponse.json({ success: true, ingested, deduped, finalised, metricsUpserted })
}
