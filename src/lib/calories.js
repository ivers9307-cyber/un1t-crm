// HR-based calorie estimate (Keytel et al., 2005). Pure — no DB.
// kcal/min from heart rate, with sex-specific coefficients; ×duration.
// Used to fill heart_rate_sessions.calories_kcal for in-studio bridge sessions
// (imported wearable sessions already carry a provider value).

import { normaliseGender } from './gender.js'

function maleKcalPerMin(hr, weightKg, age) {
  return (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184
}
function femaleKcalPerMin(hr, weightKg, age) {
  return (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.0740 * age) / 4.184
}

/**
 * @param {{ avgHr:number, durationMin:number, age:number, weightKg:number, gender:string|null }} args
 * @returns {number|null} whole kcal, or null if any required input is missing/non-positive.
 *   gender is normalised via normaliseGender ('M'/'Female'/case variants map to
 *   the sex-specific curve); anything unknown (legacy 'P', 'other', null,
 *   'not_specified') → sex-neutral mean.
 */
export function estimateCaloriesKcal({ avgHr, durationMin, age, weightKg, gender }) {
  const ok = (n) => Number.isFinite(n) && n > 0
  if (!ok(avgHr) || !ok(durationMin) || !ok(age) || !ok(weightKg)) return null

  const male = maleKcalPerMin(avgHr, weightKg, age) * durationMin
  const female = femaleKcalPerMin(avgHr, weightKg, age) * durationMin
  const g = normaliseGender(gender)
  let total
  if (g === 'male') total = male
  else if (g === 'female') total = female
  else total = (male + female) / 2

  if (!Number.isFinite(total) || total <= 0) return null
  return Math.round(total)
}
