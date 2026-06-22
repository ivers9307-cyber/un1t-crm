// Open Wearables (OW) → heart_rate_sessions field mapper.
//
// PURE: data → data. No IO, no Supabase, no env — so the webhook receiver
// (IB5) can call it after fetching a workout + its HR samples from the OW
// client (src/lib/openwearables.js), and so the whole thing is fully
// fixture-testable. The caller is responsible for the columns that need a
// DB lookup or correlation — `contact_id`, `location_id`, and the class
// link (`glofox_event_id` / `class_name` / `class_link_source`); this
// mapper never sets those.
//
// The heart-rate math is reused verbatim from heart-rate.js
// (`summariseSession`) so an Apple-Health session and a BLE-bridge session
// produce identical zones_seconds / effort_points / avg / peak for the same
// samples. Apple Watch numbers and chest-strap numbers must line up for the
// same human across both ingest paths.
//
// Input shapes (from the live OW spec — Workout-Output + TimeSeriesSample):
//   workout: {
//     id, type, name?, start_time, end_time, duration_seconds?,
//     calories_kcal?, distance_meters?, avg_heart_rate_bpm?,
//     max_heart_rate_bpm?, source
//   }  — start_time / end_time are ISO datetime strings.
//   hrSamples: Array<{ timestamp, value, unit }> — OW TimeSeriesSample for
//     type='heart_rate'; `value` is bpm. May be empty/absent.
//
// Output: the field set for a `heart_rate_sessions` insert (see mig 110 +
// the source-CHECK that already allows 'apple_health'). Columns NOT set
// here (caller's job): id, contact_id, location_id, booking_id,
// glofox_event_id, class_name, class_link_source, created_at.

import { summariseSession } from './heart-rate.js'

/**
 * Map one Open Wearables workout (+ its HR samples) to the field set for a
 * heart_rate_sessions insert. Pure + defensive — never throws on a sparse
 * or malformed workout; always returns a valid payload.
 *
 * @param {object} args
 * @param {object} args.workout      Workout-Output object (see module header).
 * @param {Array<{timestamp: string, value: number, unit?: string}>} [args.hrSamples]
 *        OW heart_rate TimeSeriesSamples. Empty/absent → no-HR (participation) path.
 * @param {number} args.maxHr        Resolved max HR for the contact (caller computes
 *        via resolveMaxHr). Stored as max_hr_used and used for zone math.
 * @param {{ zonePoints?: object, participationPoints?: number }} args.scoring
 *        Operator-configurable scoring (from resolveScoringConfig): per-zone
 *        points rate + the flat no-HR participation value.
 * @param {string} [args.provider='apple']  The OW provider key (stamped into
 *        raw_metadata.ow_provider for traceability).
 * @returns {{
 *   source: 'apple_health',
 *   started_at: any,
 *   ended_at: any,
 *   max_hr_used: number,
 *   device_identifier: null,
 *   avg_hr_bpm: number|null,
 *   peak_hr_bpm: number|null,
 *   zones_seconds: object,
 *   effort_points: number,
 *   raw_metadata: { ow_workout_id: any, ow_provider: string, ow_type: any },
 * }}
 */
export function mapAppleWorkoutToSession({
  workout,
  hrSamples,
  maxHr,
  scoring,
  provider = 'apple',
} = {}) {
  const w = workout || {}
  const s = scoring || {}

  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

  // Fields that hold regardless of whether we have HR samples.
  const base = {
    source: 'apple_health',
    started_at: w.start_time ?? null,
    ended_at: w.end_time ?? null,
    max_hr_used: maxHr,
    // Apple/OW sessions aren't tied to a physical strap; the OW workout id is
    // the dedup/trace key and lives in raw_metadata, not device_identifier.
    device_identifier: null,
    raw_metadata: {
      // The dedup key IB5 uses to avoid double-inserting a re-delivered workout.
      ow_workout_id: w.id ?? null,
      ow_provider: provider,
      ow_type: w.type ?? null,
    },
    workout_type: w.type ?? null,
    calories_kcal: num(w.calories_kcal),
    distance_meters: num(w.distance_meters),
    avg_pace_sec_per_km: num(w.avg_pace_sec_per_km),
  }

  // Convert OW samples → the shape summariseSession expects, dropping rows
  // that can't contribute (non-finite bpm or missing timestamp). Defensive:
  // tolerate a non-array hrSamples (treat as empty). Note `Number(null)` and
  // `Number('')` are 0 (finite!), so guard the raw value separately — a
  // null/empty bpm is missing data, not a real zero reading.
  const samples = (Array.isArray(hrSamples) ? hrSamples : [])
    .map((sample) => ({
      recorded_at: sample?.timestamp,
      bpm: sample?.value === null || sample?.value === undefined || sample?.value === ''
        ? NaN
        : Number(sample.value),
    }))
    .filter((sample) => sample.recorded_at != null && Number.isFinite(sample.bpm))

  if (samples.length > 0) {
    // HR path — compute zones + points + avg/peak from the samples.
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

  // No-HR path — attended-but-no-strap. Flat participation points, empty
  // zones, and avg/peak taken from the workout's own aggregates (which Apple
  // may still provide even without a per-sample series).
  return {
    ...base,
    effort_points: s.participationPoints,
    zones_seconds: {},
    avg_hr_bpm: w.avg_heart_rate_bpm ?? null,
    peak_hr_bpm: w.max_heart_rate_bpm ?? null,
  }
}
