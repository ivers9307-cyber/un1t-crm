// Pure mappers for the Apple Health `body` block (weight + dob + biological sex).
// No DB. The ingest route applies the parsed values (weight freshest-wins;
// dob/gender only-if-null).

// Apple Health metric keys the champ-app uploads use some short aliases; the
// member_health_metrics consumer (champ-app wearable-trends-view) reads canonical
// keys. Normalize at ingest so HRV/VO2max actually surface.
const METRIC_KEY_ALIASES = { hrv: 'heart_rate_variability_sdnn', vo2max: 'vo2_max' }
export function normalizeHealthMetricKey(metric) {
  const k = String(metric ?? '').trim()
  return METRIC_KEY_ALIASES[k] || k
}

// NOTE: deliberately NOT the shared normaliseGender (src/lib/gender.js) —
// Apple Health's biological_sex preserves 'other' as a stored contacts.gender
// value (member-owned, only-if-null), while normaliseGender folds anything
// non-male/female to null. Different semantics; keep them separate.
const GENDERS = ['female', 'male', 'other']

export function mapBiologicalSexToGender(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  return GENDERS.includes(v) ? v : null
}

/**
 * @returns {{ weightKg:number|null, weightAt:string|null, dob:string|null, gender:string|null }}
 */
export function parseBodyBlock(body) {
  const b = body || {}
  const wRaw = Number(b.weight_kg)
  const weightKg = Number.isFinite(wRaw) && wRaw >= 20 && wRaw <= 300 ? wRaw : null
  const weightAt = typeof b.weight_at === 'string' && Number.isFinite(Date.parse(b.weight_at)) ? b.weight_at : null
  let dob = null
  if (typeof b.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.dob)) {
    const t = Date.parse(`${b.dob}T00:00:00Z`)
    if (Number.isFinite(t) && t <= Date.now()) dob = b.dob
  }
  return { weightKg, weightAt, dob, gender: mapBiologicalSexToGender(b.biological_sex) }
}
