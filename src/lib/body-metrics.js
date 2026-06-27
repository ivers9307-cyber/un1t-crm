import { computeAge } from '@/lib/heart-rate'
import { logWarn } from '@/lib/log'

/**
 * Pure: should an incoming weight observation overwrite the current canonical
 * weight? Freshest-wins (>= so an equal-timestamp refresh re-stamps source).
 * Rejects a non-finite/non-positive incoming weight.
 */
export function shouldApplyWeight(current, { weightKg, observedAt }) {
  if (!Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0) return false
  const curAt = current?.weight_kg_at ? new Date(current.weight_kg_at).getTime() : null
  if (curAt == null) return true
  const incAt = observedAt ? new Date(observedAt).getTime() : null
  if (incAt == null) return false
  return incAt >= curAt
}

/**
 * IO: update contacts.weight_kg/_source/_at when the observation is fresher.
 * Returns true if it wrote. Best-effort — logs, never throws.
 */
export async function applyWeightObservation(db, { contactId, weightKg, source, observedAt }) {
  if (!db || !contactId) return false
  const { data: current } = await db
    .from('contacts').select('weight_kg, weight_kg_at').eq('id', contactId).maybeSingle()
  if (!shouldApplyWeight(current, { weightKg, observedAt })) return false
  const { error } = await db
    .from('contacts')
    .update({ weight_kg: Number(weightKg), weight_kg_source: source, weight_kg_at: observedAt })
    .eq('id', contactId)
  if (error) { logWarn('body-metrics', 'weight update failed', { err: error, contactId }); return false }
  return true
}

/**
 * IO: the body metrics needed to compute calories for a contact.
 * @returns {Promise<{ dob:string|null, age:number|null, gender:string|null, weightKg:number|null }>}
 */
export async function resolveBodyMetrics(db, contactId, nowMs = Date.now()) {
  const empty = { dob: null, age: null, gender: null, weightKg: null }
  if (!db || !contactId) return empty
  const { data } = await db
    .from('contacts').select('dob, gender, weight_kg').eq('id', contactId).maybeSingle()
  if (!data) return empty
  return {
    dob: data.dob ?? null,
    age: computeAge(data.dob, nowMs),
    gender: data.gender ?? null,
    weightKg: Number.isFinite(Number(data.weight_kg)) ? Number(data.weight_kg) : null,
  }
}
