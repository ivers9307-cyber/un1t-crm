// Direct Apple Health sync. Reads workouts + HR + recovery metrics from
// HealthKit on-device (@kingstinct/react-native-healthkit) and uploads them to
// un1t-crm's customer-authed ingest endpoint. Replaces the Open Wearables relay.
//
// iOS-only — the caller guards on Platform.OS. The pure shaping lives in
// shared/apple-health-payload.js (unit-tested); this file is the device IO glue
// (HealthKit queries + upload) and is verified on a real device, not in CI.

import {
  requestAuthorization,
  queryWorkoutSamples,
  queryQuantitySamples,
  configureBackgroundTypes,
  getDateOfBirth,
  getBiologicalSex,
} from '@kingstinct/react-native-healthkit'
import { buildAppleHealthPayload } from 'shared/apple-health-payload'
import { crmApi } from './api'

// The same 6 read types the OW SDK requested — full parity (workouts + HR feed
// sessions/points; resting HR / HRV / VO2max / active energy feed the Progress
// "Recovery & fitness" trends).
export const HEALTHKIT_READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierVO2Max',
  // Body block: latest weight + (immutable) characteristics. The characteristics
  // never change so they don't need background delivery — only a new weigh-in does.
  'HKQuantityTypeIdentifierBodyMass',
  'HKCharacteristicTypeIdentifierDateOfBirth',
  'HKCharacteristicTypeIdentifierBiologicalSex',
]

// HKBiologicalSex is an enum (number); map to the lib's labels. The server
// lower-cases + validates, so passing the label through is enough.
const BIOLOGICAL_SEX_LABELS = { 0: 'notSet', 1: 'female', 2: 'male', 3: 'other' }

/** Two-digit zero-pad for timezone-safe YYYY-MM-DD formatting. */
const pad2 = (n) => String(n).padStart(2, '0')

// Recovery-metric quantity types → our canonical member_health_metrics keys.
const METRIC_TYPES = [
  { id: 'HKQuantityTypeIdentifierRestingHeartRate', metric: 'resting_heart_rate', unit: 'count/min' },
  { id: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', metric: 'hrv', unit: 'ms' },
  { id: 'HKQuantityTypeIdentifierVO2Max', metric: 'vo2max', unit: 'mL/min·kg' },
  // active_energy removed: no consumer in the DB / UI — was writing 10k+ dead rows.
  // Workout-level calorie data is preserved via totalEnergyBurned on the workout sample.
]

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

/** Request HealthKit read access for the 6 types. Returns the module's result. */
export function requestAppleHealthAuthorization() {
  return requestAuthorization({ toRead: HEALTHKIT_READ_TYPES })
}

/** Enable OS-level background delivery for workouts (persists across launches). */
export async function enableAppleHealthBackground() {
  // 'immediate' so an Apple Watch workout wakes the app within minutes.
  return configureBackgroundTypes(['HKWorkoutTypeIdentifier', 'HKQuantityTypeIdentifierBodyMass'], 'immediate')
}

/**
 * Read new workouts (+ windowed HR + recovery metrics) since `sinceIso` and
 * upload them to un1t-crm. Idempotent server-side (dedup on the workout UUID),
 * so re-runs / overlapping windows are safe.
 *
 * @param {{ sinceIso?: string }} [opts]  Last successful cursor; default = 30d ago.
 * @returns {Promise<{ ok: boolean, ingested?: number, cursor: string|null, error?: string }>}
 *          `cursor` = the latest workout end-time uploaded (caller persists it).
 */
export async function syncAppleHealth({ sinceIso, debug = false } = {}) {
  const startDate = sinceIso ? new Date(sinceIso) : new Date(Date.now() - THIRTY_DAYS_MS)
  const endDate = new Date()
  const dateFilter = { date: { startDate, endDate } }
  // Stage-by-stage counters — returned when `debug` so the connect screen's
  // "Sync now" can show exactly where data is (or isn't) flowing.
  const dbg = { window: { start: startDate.toISOString(), end: endDate.toISOString() } }

  // `limit` is a REQUIRED param in @kingstinct/react-native-healthkit v14
  // (0 = "all in window"). Omitting it makes the native query return empty —
  // that was the silent no-data bug. Always pass it.
  const rawWorkouts = (await queryWorkoutSamples({ limit: 0, ascending: true, filter: dateFilter })) || []
  dbg.rawWorkouts = rawWorkouts.length

  const metrics = []
  const metricCounts = {}
  for (const mt of METRIC_TYPES) {
    try {
      const rows = (await queryQuantitySamples(mt.id, { limit: 0, unit: mt.unit, ascending: true, filter: dateFilter })) || []
      metricCounts[mt.metric] = rows.length
      for (const r of rows) metrics.push({ metric: mt.metric, date: r.startDate, value: r.quantity, unit: mt.unit })
    } catch (e) {
      // A device may not have this metric type — skip it, never fail the sync.
      metricCounts[mt.metric] = `err:${e?.message || e}`
    }
  }
  dbg.metrics = metricCounts

  // Normalize the module's WorkoutSample shapes → the pure shaper's input.
  // (Quantity fields like totalEnergyBurned are { quantity, unit } objects.)
  const workouts = rawWorkouts.map((w) => ({
    uuid: w.uuid,
    activityType: w.workoutActivityType,
    startDate: w.startDate,
    endDate: w.endDate,
    energyKcal: w.totalEnergyBurned?.quantity ?? w.totalEnergyBurned,
    distanceMeters: w.totalDistance?.quantity ?? w.totalDistance,
  }))

  // HR per-workout window (bounded — a 30-day global HR query is 100k+ samples).
  // The shaper re-buckets by timestamp, so a flat concatenated list is fine.
  const hrSamples = []
  for (const w of workouts) {
    if (!w.startDate || !w.endDate) continue
    try {
      const rows = (await queryQuantitySamples('HKQuantityTypeIdentifierHeartRate', {
        limit: 0, unit: 'count/min', ascending: true,
        filter: { date: { startDate: new Date(w.startDate), endDate: new Date(w.endDate) } },
      })) || []
      for (const s of rows) hrSamples.push({ date: s.startDate, bpm: s.quantity })
    } catch {
      // Skip this workout's HR rather than failing the whole sync.
    }
  }
  dbg.hrSamples = hrSamples.length

  // Body block — latest weight + immutable characteristics (dob, biological sex).
  // Best-effort: each read is wrapped so a missing value / denied permission
  // yields null and never throws. The getters are synchronous in this lib version
  // (Date | undefined for dob, an HKBiologicalSex enum number for sex).
  let body = null
  try {
    let weightKg = null
    let weightAt = null
    try {
      const wRows = (await queryQuantitySamples('HKQuantityTypeIdentifierBodyMass', { limit: 1, unit: 'kg', ascending: false })) || []
      const latest = wRows[0]
      if (latest) {
        weightKg = Number(latest.quantity)
        weightAt = latest.endDate || latest.startDate || null
      }
    } catch { /* no body-mass / no permission — leave null */ }

    let dob = null
    try {
      const dobRaw = getDateOfBirth() // Date | undefined
      if (dobRaw instanceof Date && Number.isFinite(dobRaw.getTime())) {
        // Use LOCAL date components, not toISOString() — the latter can shift the
        // day across a timezone boundary (a midnight-local birthday becomes the
        // previous day in UTC).
        dob = `${dobRaw.getFullYear()}-${pad2(dobRaw.getMonth() + 1)}-${pad2(dobRaw.getDate())}`
      }
    } catch { /* no dob / no permission — leave null */ }

    let biologicalSex = null
    try {
      const sexRaw = getBiologicalSex() // HKBiologicalSex enum (number) or string
      const label = typeof sexRaw === 'number' ? BIOLOGICAL_SEX_LABELS[sexRaw] : sexRaw
      // Drop notSet — it carries no information.
      if (label && label !== 'notSet') biologicalSex = String(label)
    } catch { /* no sex / no permission — leave null */ }

    if (weightKg != null || dob || biologicalSex) body = { weightKg, weightAt, dob, biologicalSex }
  } catch (e) {
    if (debug) dbg.bodyError = String(e?.message || e)
  }
  if (debug) dbg.body = body

  const payload = buildAppleHealthPayload({ workouts, hrSamples, metrics, body })
  dbg.payloadWorkouts = payload.workouts.length
  dbg.payloadMetrics = payload.healthMetrics.length

  if (payload.workouts.length === 0 && payload.healthMetrics.length === 0 && !payload.body) {
    return { ok: true, ingested: 0, cursor: sinceIso ?? null, ...(debug ? { debug: dbg } : {}) }
  }

  const res = await crmApi('/api/wearables/apple-health/ingest', { method: 'POST', body: payload })
  if (res?.success === false) return { ok: false, error: res.error, cursor: sinceIso ?? null, ...(debug ? { debug: dbg } : {}) }

  // New cursor: advance to the query window's END, not just the latest workout
  // end-time. The upload just succeeded for everything in [startDate, endDate]
  // (workouts, windowed HR, recovery metrics AND body), so the whole window is
  // durably ingested and there's no reason to re-read any of it next time.
  //
  // Anchoring the cursor only on workout end-times (the old behaviour) meant a
  // sync that ingested ONLY health metrics/body data left the cursor unchanged,
  // so the next sync re-read + re-uploaded the same ever-growing window forever —
  // wasted battery/bandwidth for watch-less members (server dedups, but the work
  // still happens on-device). endDate is always >= any workout end-time in the
  // window, so this also preserves the workout-based floor.
  const maxWorkoutEndMs = payload.workouts.reduce((max, w) => {
    const t = Date.parse(w.workout.end_time)
    return Number.isFinite(t) && t > max ? t : max
  }, 0)
  const windowEndMs = endDate.getTime()
  const priorMs = sinceIso ? Date.parse(sinceIso) : 0
  // Never move the cursor BACKWARDS (guards a bad prior cursor in the future).
  const nextMs = Math.max(
    windowEndMs,
    maxWorkoutEndMs,
    Number.isFinite(priorMs) ? priorMs : 0,
  )
  const cursor = nextMs > 0 ? new Date(nextMs).toISOString() : (sinceIso ?? null)
  dbg.ingested = res?.ingested ?? 0
  return { ok: true, ingested: res?.ingested ?? 0, cursor, ...(debug ? { debug: dbg } : {}) }
}
