// STAFFCOST.1 — who a scheduled RATE-BEARING report may be emailed to.
//
// scheduled_reports.email_recipients is free text typed by whoever created
// the schedule, so a staff_cost schedule can name a head coach — and before
// STAFFCOST.1 a head coach could create one and name themselves. The email
// carries the report summary, which for staff_cost is the location's regular,
// overtime and total cost.
//
// Rule, per recipient address:
//   - matches a STAFF profile (case-insensitive, literal) → sent only if that
//     person may see rate reports at the schedule's location: master, an
//     explicit owner/manager row there, or an org admin of the location's
//     organisation with no explicit row there (the same resolution
//     getCurrentUser's expandOrgAdminAccess applies — an explicit row wins).
//     A head coach, a staff member, or someone with no role at the location
//     is dropped.
//   - matches no profile → sent. Those are addresses the owner/manager who
//     set the schedule chose on purpose (an accountant, a shared finance
//     inbox), and since STAFFCOST.1 only an owner/manager can create a
//     staff_cost schedule. Known limit: a head coach's PERSONAL address that
//     is not on their profile cannot be recognised.
//   - the lookup itself fails → that recipient is dropped and the failure is
//     logged. Fail closed is right here: the harm is pay data in the wrong
//     inbox, while a missed internal summary is recoverable from Schedule →
//     Reporting.
//
// Non-rate report types are not filtered — call this only for rate types.

import { escapeLikePattern } from '@/lib/like-escape'
import { logError } from '@/lib/log'
import { RATE_REPORT_VIEWER_ROLES } from '@/lib/report-access'

/**
 * @param {object} args
 * @param {object} args.db             service-role client
 * @param {string} args.locationId     the schedule's location
 * @param {string[]} args.recipients   raw addresses from the schedule
 * @returns {Promise<{ allowed: string[], dropped: Array<{ email: string, reason: string }> }>}
 */
export async function filterRateReportRecipients({ db, locationId, recipients }) {
  const allowed = []
  const dropped = []
  let orgIdCache // undefined = not looked up yet

  async function locationOrgId() {
    if (orgIdCache !== undefined) return orgIdCache
    const { data, error } = await db.from('locations')
      .select('organization_id')
      .eq('id', locationId)
      .maybeSingle()
    if (error) throw new Error(`location lookup failed: ${error.message}`)
    orgIdCache = data?.organization_id || null
    return orgIdCache
  }

  for (const raw of recipients || []) {
    const email = String(raw || '').trim()
    if (!email) continue
    try {
      // Literal, case-insensitive equality: profile emails are stored as
      // typed, and a bare ilike would treat `_`/`%` as wildcards.
      const { data: profiles, error: profileError } = await db.from('profiles')
        .select('id, role')
        .ilike('email', escapeLikePattern(email))
      if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`)
      if (!profiles || profiles.length === 0) {
        allowed.push(email)
        continue
      }

      // Every matching profile must be allowed — if one address somehow maps
      // to two profiles, the stricter answer wins.
      let ok = true
      for (const profile of profiles) {
        if (profile.role === 'master') continue
        const { data: link, error: linkError } = await db.from('profile_locations')
          .select('role')
          .eq('profile_id', profile.id)
          .eq('location_id', locationId)
          .maybeSingle()
        if (linkError) throw new Error(`role lookup failed: ${linkError.message}`)
        if (link) {
          if (!RATE_REPORT_VIEWER_ROLES.includes(link.role)) { ok = false; break }
          continue
        }
        const orgId = await locationOrgId()
        if (!orgId) { ok = false; break }
        const { data: orgGrant, error: orgError } = await db.from('profile_organizations')
          .select('role')
          .eq('profile_id', profile.id)
          .eq('organization_id', orgId)
          .eq('role', 'org_admin')
          .limit(1)
        if (orgError) throw new Error(`org admin lookup failed: ${orgError.message}`)
        if (!orgGrant || orgGrant.length === 0) { ok = false; break }
      }

      if (ok) allowed.push(email)
      else dropped.push({ email, reason: 'not_rate_viewer' })
    } catch (e) {
      logError('report-recipients', 'recipient check failed, not sending the rate report to this address', {
        locationId, err: e?.message || String(e),
      })
      dropped.push({ email, reason: 'lookup_failed' })
    }
  }

  return { allowed, dropped }
}
