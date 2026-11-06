// PIPEBUILD.1g — the pieces of a sequence step's fire-time clamp that both the
// scheduler and the template-approval wake-up (template-wait.js) need. A leaf
// module: scheduler.js imports template-wait.js, so template-wait.js cannot
// import scheduler.js without a cycle. scheduler.js re-exports hasSendWindow
// so every existing import path keeps working.

import { QUIET_HOURS_COLUMNS } from '@/lib/send-quiet-hours'

/**
 * Does this send_window actually constrain anything?
 *
 * Deliberately the same predicate clampToSendWindow uses to decide it has
 * nothing to do: null/undefined, `{}`, and `{ start_hour: null, end_hour:
 * null, skip_days: [] }` all mean "the operator configured no window". They
 * must agree, or an empty object would count as a sequence-level window and
 * silently block the quiet-hours fallback.
 *
 * @param {object|null|undefined} window
 * @returns {boolean}
 */
export function hasSendWindow(window) {
  if (!window || typeof window !== 'object') return false
  if (Number.isFinite(window.start_hour)) return true
  if (Number.isFinite(window.end_hour)) return true
  return Array.isArray(window.skip_days) && window.skip_days.length > 0
}

export const QUIET_HOURS_SELECT =
  `${QUIET_HOURS_COLUMNS.enabled}, ${QUIET_HOURS_COLUMNS.start}, ${QUIET_HOURS_COLUMNS.end}`

/**
 * The company_settings quiet-hours row for a location, or null when the
 * location has none (normalizeQuietHours reads null as the code-side default).
 * THROWS when the read fails, so a caller that must not guess can tell
 * "no row" from "could not read".
 */
export async function readQuietHours(db, locationId) {
  if (!locationId) return null
  const { data, error } = await db
    .from('company_settings')
    .select(QUIET_HOURS_SELECT)
    .eq('location_id', locationId)
    .limit(1)
  if (error) throw new Error(`company_settings quiet hours unreadable: ${error.message}`)
  return (data && data[0]) || null
}

/**
 * The scheduler's reading: a missing row OR a read failure returns null,
 * which normalizeQuietHours reads as "use the code-side default" — the same
 * posture as the settings route. A location with no settings row must not
 * silently mean "no quiet hours"; that is the whole point of the default
 * existing in two places.
 */
export async function loadQuietHours(db, locationId) {
  try {
    return await readQuietHours(db, locationId)
  } catch {
    return null
  }
}
