// CONTRACTORSPEND.1 — pay for the people who HOLD shifts.
//
// Contractor spend and the publish budget gate used to look pay up for THIS
// studio's members (profile_locations), so a contractor from the sibling
// studio who covered a class here was priced at €0, and the spend panel also
// skipped anyone deactivated. Pricing belongs to whoever holds the shift, so
// both now read pay for the holders of the blocks they are pricing, through
// this one helper — the two figures cannot disagree about who is paid.
//
// Pay comes from profile_compensation (mig 152, the canonical copy; the
// profiles columns are deprecated, mig 153), through getCompensationForProfiles,
// which throws on a failed read. The type comes from profiles by NAMED columns
// (CLAUDE.md: profiles still carries pay columns, so never select '*').
//
// Server-only (service-role client). Nothing here may reach a browser: callers
// turn it into studio totals.

import { liveAssignments } from './roster'
import { getCompensationForProfiles } from './profile-compensation'

const ID_CHUNK = 200

/** Every profile id holding a LIVE assignment on these blocks, once each. */
export function liveHolderIds(blocks) {
  const ids = new Set()
  for (const b of blocks || []) {
    for (const a of liveAssignments(b?.shift_assignments)) {
      if (a?.profile_id) ids.add(a.profile_id)
    }
  }
  return [...ids]
}

/**
 * @param {object} db  service-role client
 * @param {string[]} profileIds
 * @returns {Promise<Map<string, {
 *   employment_type: string|null, hourly_rate: number|null,
 *   annual_salary: number|null, contracted_hours_per_week: number|null,
 * }>>}  a holder with no profiles row is absent; THROWS on a failed read
 */
export async function loadHolderPay(db, profileIds) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const out = new Map()
  if (ids.length === 0) return out
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db.from('profiles').select('id, employment_type').in('id', slice)
    if (error) throw new Error(`profiles read failed: ${error.message || error}`)
    for (const p of data || []) {
      out.set(p.id, { employment_type: p.employment_type ?? null, hourly_rate: null, annual_salary: null, contracted_hours_per_week: null })
    }
  }
  const comp = await getCompensationForProfiles(db, ids)
  for (const [id, c] of comp) {
    const p = out.get(id)
    if (!p) continue
    p.hourly_rate = c.hourly_rate
    p.annual_salary = c.annual_salary
    p.contracted_hours_per_week = c.contracted_hours_per_week
  }
  return out
}
