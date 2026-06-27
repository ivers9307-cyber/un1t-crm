// Pure mappers for the Apple Health `body` block (weight + dob + biological sex).
// No DB. The ingest route applies the parsed values (weight freshest-wins;
// dob/gender only-if-null).

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
