// Canonical gender normaliser. Pure — no DB.
//
// Real-world gender values are messy: Glofox members carry 'Male'/'Female'
// but also single-letter codes ('M'/'F'), a legacy 'P' code (≈ "prefer not
// to say" — recorded on mig 322), 'not_specified', and blanks. The calorie
// estimator (src/lib/calories.js) is sex-specific and exact-matches
// 'male'/'female', so any unnormalised variant silently degrades the
// estimate to the sex-neutral mean.
//
// Shared by BOTH ends of the pipe:
//   - producer: glofox-sync extractMemberProfile stores the canonical value
//     on contacts.gender (braces),
//   - consumer: estimateCaloriesKcal normalises whatever it is handed, so
//     legacy rows already in the DB still compute correctly (belt).
//
// NOT used by apple-health-body.js's mapBiologicalSexToGender — Apple Health
// deliberately preserves 'other' as a stored value, which this helper folds
// to null. Different semantics; see the comment there.

/**
 * @param {*} value raw gender value from any source
 * @returns {'male'|'female'|null} canonical value, or null for anything
 *   unknown (legacy 'P', 'not_specified', 'other', empty, non-string).
 */
export function normaliseGender(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === 'male' || v === 'm') return 'male'
  if (v === 'female' || v === 'f') return 'female'
  return null
}
