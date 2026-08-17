// Pure shaper: HealthKit query results (normalized by the native sync lib) →
// the upload payload the un1t-crm ingest endpoint expects. No HealthKit, no IO,
// so it's fully unit-testable; the native layer (mobile/lib/apple-health-sync)
// adapts the @kingstinct/react-native-healthkit output into the input shape.
//
// Input:
//   workouts: [{ uuid, activityType, startDate, endDate, energyKcal?,
//                distanceMeters?, avgHeartRateBpm?, maxHeartRateBpm? }]
//   hrSamples: [{ date, bpm }]   — HR samples; windowed onto each workout here
//   metrics:   [{ metric, date, value, unit? }]   — metric = our canonical key
//   (dates are Date objects OR ISO strings)
//
// Output (matches POST /api/wearables/apple-health/ingest):
//   { workouts: [{ workout: <Workout-Output>, hrSamples: [{ timestamp, value }] }],
//     healthMetrics: [{ metric, recorded_at, value, unit }] }

function toIso(d) {
  if (!d) return null
  const t = d instanceof Date ? d.getTime() : Date.parse(d)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function msOf(d) {
  if (!d) return NaN
  return d instanceof Date ? d.getTime() : Date.parse(d)
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// HealthKit activity-type identifier → our workout_type key (snake_case). The
// generic CamelCase→snake conversion handles every HKWorkoutActivityType*
// identifier (Running→running, FunctionalStrengthTraining→
// functional_strength_training, …) so un1t-crm's workoutLabel renders them.
export function normalizeActivityType(raw) {
  if (raw == null || raw === '') return 'other'
  const s = String(raw).replace(/^HKWorkoutActivityType/, '')
  const snake = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return snake || 'other'
}

export function buildAppleHealthPayload({ workouts = [], hrSamples = [], metrics = [], body = null } = {}) {
  // Usable HR samples (finite bpm + a parseable time).
  const samples = (Array.isArray(hrSamples) ? hrSamples : [])
    .map((s) => ({ at: msOf(s?.date), bpm: num(s?.bpm), iso: toIso(s?.date) }))
    .filter((s) => Number.isFinite(s.at) && s.bpm != null && s.iso)

  const outWorkouts = (Array.isArray(workouts) ? workouts : [])
    .filter((w) => w?.uuid && w?.startDate && w?.endDate)
    .map((w) => {
      const startMs = msOf(w.startDate)
      const endMs = msOf(w.endDate)
      const windowed = samples
        .filter((s) => s.at >= startMs && s.at <= endMs)
        .map((s) => ({ timestamp: s.iso, value: s.bpm }))
      return {
        workout: {
          id: String(w.uuid),
          type: normalizeActivityType(w.activityType),
          start_time: toIso(w.startDate),
          end_time: toIso(w.endDate),
          calories_kcal: num(w.energyKcal),
          distance_meters: num(w.distanceMeters),
          avg_heart_rate_bpm: num(w.avgHeartRateBpm),
          max_heart_rate_bpm: num(w.maxHeartRateBpm),
        },
        hrSamples: windowed,
      }
    })

  const healthMetrics = (Array.isArray(metrics) ? metrics : [])
    .filter((m) => m?.metric && m?.date && m?.value != null && Number.isFinite(Number(m.value)))
    .map((m) => ({ metric: String(m.metric), recorded_at: toIso(m.date), value: Number(m.value), unit: m.unit ?? null }))
    .filter((m) => m.recorded_at)

  // Body block (weight + dob + biological sex) — only present fields; omit if empty.
  const b = body || {}
  const bodyOut = {}
  if (num(b.weightKg) != null) {
    bodyOut.weight_kg = num(b.weightKg)
    const wAt = toIso(b.weightAt)
    if (wAt) bodyOut.weight_at = wAt
  }
  if (typeof b.dob === 'string' && b.dob) bodyOut.dob = b.dob
  if (b.biologicalSex) bodyOut.biological_sex = String(b.biologicalSex)

  return { workouts: outWorkouts, healthMetrics, ...(Object.keys(bodyOut).length ? { body: bodyOut } : {}) }
}
