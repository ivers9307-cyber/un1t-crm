// Pure profile-setup logic shared across surfaces. No RN/DOM/IO.

const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000
const GENDERS = ['female', 'male', 'other']

// The ProfileCompletionPrompt is a *snooze*, not a permanent dismiss: after this
// window it re-appears if the fields are still empty. Longer than the wizard's
// 24h cooldown so we don't nag, but short enough that a member who skipped is
// reminded again within the week.
export const COMPLETION_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Should the ProfileCompletionPrompt be shown right now?
 * Pure: combines "is a calorie field missing" with the snooze window.
 * Re-appears once the snooze elapses (dismissal is a snooze, not permanent) —
 * and the caller stops rendering entirely once the fields are filled (missing = []).
 */
export function shouldShowCompletionPrompt(contact, { snoozedAtMs = null, nowMs = Date.now() } = {}) {
  if (!blocksCalories(contact)) return false
  if (snoozedAtMs != null && nowMs - snoozedAtMs < COMPLETION_SNOOZE_MS) return false
  return true
}

/**
 * What should the app show for this member's profile setup?
 * @returns {'complete'|'wizard'|'nudge'}
 */
export function profileSetupStatus(contact, { dismissedAtMs = null, nowMs = Date.now() } = {}) {
  if (!contact || contact.profile_setup_completed_at) return 'complete'
  if (dismissedAtMs != null && nowMs - dismissedAtMs < DISMISS_COOLDOWN_MS) return 'nudge'
  return 'wizard'
}

// Field keys that feed the calorie / HR-zone maths. `dob` (age) and `weight_kg`
// are hard inputs to the Keytel calorie formula; `gender` selects the formula
// coefficients. All three must be present for accurate calories + zones.
export const CALORIE_FIELDS = ['dob', 'gender', 'weight_kg']

const CALORIE_FIELD_LABELS = {
  dob: 'Date of birth',
  gender: 'Gender',
  weight_kg: 'Weight',
}

export function calorieFieldLabel(key) {
  return CALORIE_FIELD_LABELS[key] || key
}

/**
 * Which calorie/zone-driving metrics is this member still missing?
 * Pure + null-safe. Reuses the same validity rules as validateAboutYou
 * (a present-but-invalid value counts as missing).
 * @returns {Array<'dob'|'gender'|'weight_kg'>} missing field keys, in canonical order
 */
export function missingCalorieFields(contact) {
  if (!contact) return []
  const missing = []
  if (!GENDERS.includes(contact.gender)) missing.push('gender')
  const w = normalizeWeightKg(contact.weight_kg)
  if (w == null || w < 20 || w > 300) missing.push('weight_kg')
  const dob = contact.dob
  const dobOk =
    typeof dob === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(dob) &&
    Number.isFinite(Date.parse(`${dob}T00:00:00Z`)) &&
    Date.parse(`${dob}T00:00:00Z`) <= Date.now()
  if (!dobOk) missing.push('dob')
  // Canonical order (dob, gender, weight_kg) for stable display.
  return CALORIE_FIELDS.filter((k) => missing.includes(k))
}

/**
 * True when the member is missing a metric that blocks accurate calories/zones.
 * The trigger for the ProfileCompletionPrompt.
 */
export function blocksCalories(contact) {
  return missingCalorieFields(contact).length > 0
}

export function normalizeWeightKg(input) {
  if (input == null) return null
  const s = String(input).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Validate the required "About you" fields. Mirrors the un1t-crm
 * /api/me/body-metrics bounds so we fail fast client-side.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAboutYou({ dob, gender, weight_kg } = {}) {
  if (!GENDERS.includes(gender)) return { ok: false, error: 'Select your gender' }
  const w = normalizeWeightKg(weight_kg)
  if (w == null || w < 20 || w > 300) return { ok: false, error: 'Enter a weight between 20 and 300 kg' }
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { ok: false, error: 'Enter your date of birth' }
  const t = Date.parse(`${dob}T00:00:00Z`)
  if (!Number.isFinite(t) || t > Date.now()) return { ok: false, error: 'Enter a valid date of birth' }
  return { ok: true }
}
