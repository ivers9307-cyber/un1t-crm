// Apple Health (HealthKit) workout → heart_rate_sessions field mapper.
//
// PURE: data → data. No IO, no Supabase, no env — so the direct-ingest
// endpoint (/api/wearables/apple-health/ingest) can call it after the member's
// device reads HealthKit and uploads a batch, and so the whole thing is fully
// fixture-testable. The caller sets the columns that need a DB lookup or
// correlation — contact_id, location_id, and the class link
// (glofox_event_id / class_name / class_link_source); this mapper never does.
//
// The heart-rate math is reused verbatim from heart-rate.js (summariseSession)
// so an Apple-Watch session and a BLE-bridge session produce identical
// zones_seconds / effort_points / avg / peak for the same samples.
//
// Input shapes (the device uploads in this Workout-Output shape):
//   workout: {
//     id, type, name?, start_time, end_time, duration_seconds?,
//     calories_kcal?, distance_meters?, avg_pace_sec_per_km?,
//     avg_heart_rate_bpm?, max_heart_rate_bpm?
//   }  — id is the HealthKit workout UUID (dedup key); start/end are ISO.
//   hrSamples: Array<{ timestamp, value, unit? }> — heart-rate samples for the
//     workout window; `value` is bpm. May be empty/absent (no-HR path).
//
// Output: the field set for a heart_rate_sessions insert. Columns NOT set here
// (caller's job): id, contact_id, location_id, booking_id, glofox_event_id,
// class_name, class_link_source, created_at.

import { summariseSession } from './heart-rate.js'

/**
 * Map one Apple Health workout (+ its HR samples) to a heart_rate_sessions
 * insert payload. Pure + defensive — never throws on a sparse/malformed
 * workout; always returns a valid payload.
 *
 * @param {object} args
 * @param {object} args.workout   Workout-Output object (see module header).
 * @param {Array<{timestamp: string, value: number, unit?: string}>} [args.hrSamples]
 *        Heart-rate samples. Empty/absent → no-HR (participation) path.
 * @param {number} args.maxHr     Resolved max HR for the contact (caller via
 *        resolveMaxHr). Stored as max_hr_used + used for zone math.
 * @param {{ zonePoints?: object, participationPoints?: number }} args.scoring
 *        Operator-configurable scoring (resolveScoringConfig).
 * @returns {object} heart_rate_sessions field set.
 */
export function mapAppleHealthWorkoutToSession({
  workout,
  hrSamples,
  maxHr,
  scoring,
} = {}) {
  const w = workout || {}
  const s = scoring || {}

  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

  const base = {
    source: 'apple_health',
    started_at: w.start_time ?? null,
    ended_at: w.end_time ?? null,
    max_hr_used: maxHr,
    // Apple sessions aren't tied to a physical strap; the HealthKit workout
    // UUID is the dedup/trace key and lives in raw_metadata, not device_identifier.
    device_identifier: null,
    raw_metadata: {
      // The dedup key the ingest endpoint uses to skip a re-uploaded workout.
      apple_workout_uuid: w.id ?? null,
      apple_workout_type: w.type ?? null,
    },
    workout_type: w.type ?? null,
    calories_kcal: num(w.calories_kcal),
    distance_meters: num(w.distance_meters),
    avg_pace_sec_per_km: num(w.avg_pace_sec_per_km),
  }

  // Convert samples → the shape summariseSession expects, dropping rows that
  // can't contribute (non-finite bpm or missing timestamp). Tolerate a
  // non-array hrSamples. Number(null)/Number('') are 0 (finite!), so guard the
  // raw value separately — a null/empty bpm is missing data, not a real zero.
  const samples = (Array.isArray(hrSamples) ? hrSamples : [])
    .map((sample) => ({
      recorded_at: sample?.timestamp,
      bpm: sample?.value === null || sample?.value === undefined || sample?.value === ''
        ? NaN
        : Number(sample.value),
    }))
    .filter((sample) => sample.recorded_at != null && Number.isFinite(sample.bpm))

  if (samples.length > 0) {
    const { zonesSeconds, effortPoints, avgHrBpm, peakHrBpm } = summariseSession(
      samples,
      maxHr,
      { zonePoints: s.zonePoints },
    )
    return {
      ...base,
      effort_points: effortPoints,
      zones_seconds: zonesSeconds,
      avg_hr_bpm: avgHrBpm,
      peak_hr_bpm: peakHrBpm,
    }
  }

  // No-HR path — attended-but-no-strap. Flat participation points, empty zones,
  // avg/peak from the workout's own aggregates.
  return {
    ...base,
    effort_points: s.participationPoints,
    zones_seconds: {},
    avg_hr_bpm: w.avg_heart_rate_bpm ?? null,
    peak_hr_bpm: w.max_heart_rate_bpm ?? null,
  }
}
