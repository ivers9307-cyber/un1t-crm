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
//     A head coach, a staff member, someone with no role at the location, or
//     a DEACTIVATED profile (even with a role row left behind) is dropped.
//   - matches no profile → sent ONLY if the address is on the schedule's
//     confirmed_external_recipients (REPORTS.2, mig 617). Those are addresses
//     the owner/manager who saved the schedule explicitly confirmed as
//     external (an accountant, a shared finance inbox). Before REPORTS.2 every
//     unmatched address was sent, so a head coach's PERSONAL address — which
//     no profile carries — went through. The save routes now refuse an
//     unconfirmed external address (checkRateReportRecipientsForSave), and
//     the sender checks the record again. When the schedule row carries no
//     such field at all (the column is not there yet: code deployed ahead of
//     mig 617) the pre-617 rule applies, so a deploy-order slip cannot stop a
//     report an owner set up.
//   - the lookup itself fails → that recipient is dropped and the failure is
//     logged. Fail closed is right here: the harm is pay data in the wrong
//     inbox, while a missed internal summary is recoverable from Schedule →
//     Reporting.
//
// Non-rate report types are not filtered — call this only for rate types.

import { escapeLikePattern } from '@/lib/like-escape'
import { logError } from '@/lib/log'
import { RATE_REPORT_VIEWER_ROLES } from '@/lib/report-access'

export const normaliseRecipient = (email) => String(email || '').trim().toLowerCase()

/**
 * Sort each address into what the rule needs to know about it.
 *
 * @returns {Promise<Array<{ email: string, kind: 'rate_viewer' | 'not_rate_viewer' | 'no_profile' | 'lookup_failed' }>>}
 */
export async function classifyRateReportRecipients({ db, locationId, recipients }) {
  const out = []
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
        .select('id, role, active')
        .ilike('email', escapeLikePattern(email))
      if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`)
      if (!profiles || profiles.length === 0) {
        out.push({ email, kind: 'no_profile' })
        continue
      }

      // Every matching profile must be allowed — if one address somehow maps
      // to two profiles, the stricter answer wins.
      let ok = true
      for (const profile of profiles) {
        // A deactivated staff profile is withheld whatever role rows it still
        // has: leaving the business does not end with a pay summary.
        if (profile.active === false) { ok = false; break }
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

      out.push({ email, kind: ok ? 'rate_viewer' : 'not_rate_viewer' })
    } catch (e) {
      logError('report-recipients', 'recipient check failed, treating this address as not allowed', {
        locationId, err: e?.message || String(e),
      })
      out.push({ email, kind: 'lookup_failed' })
    }
  }

  return out
}

/**
 * Who the cron may email a rate-bearing report to.
 *
 * @param {object} args
 * @param {object} args.db             service-role client
 * @param {string} args.locationId     the schedule's location
 * @param {string[]} args.recipients   raw addresses from the schedule
 * @param {string[]|null|undefined} [args.confirmedExternal]
 *   the schedule's confirmed_external_recipients. undefined/null = the row
 *   has no such column (pre-mig-617): unmatched addresses are sent as before.
 * @returns {Promise<{ allowed: string[], dropped: Array<{ email: string, reason: string }> }>}
 */
export async function filterRateReportRecipients({ db, locationId, recipients, confirmedExternal }) {
  const allowed = []
  const dropped = []
  const legacy = !Array.isArray(confirmedExternal)
  const confirmed = new Set((confirmedExternal || []).map(normaliseRecipient))
  for (const { email, kind } of await classifyRateReportRecipients({ db, locationId, recipients })) {
    if (kind === 'rate_viewer') allowed.push(email)
    else if (kind === 'no_profile') {
      if (legacy || confirmed.has(normaliseRecipient(email))) allowed.push(email)
      else dropped.push({ email, reason: 'unconfirmed_external' })
    } else dropped.push({ email, reason: kind })
  }
  return { allowed, dropped }
}

/**
 * REPORTS.2 — the SAVE-time rule for a rate-bearing schedule's recipients.
 *
 *   - a staff profile that may see rates at the location → fine.
 *   - a staff profile that may NOT (a head coach, a deactivated manager,
 *     someone from another studio) → refused outright; no confirmation can
 *     override it.
 *   - no profile → an external address. Allowed only when it was already
 *     confirmed on this schedule, or the caller confirms it now
 *     (`confirmExternal: true`). Otherwise it is returned in
 *     `needsConfirmation` so the UI can ask.
 *   - lookup failed → `lookupFailed`; the route answers 503 and saves nothing.
 *
 * `confirmedExternal` is what to store: every external address on the list
 * that is confirmed after this save (lower-cased). An address removed from
 * the recipients drops out of it.
 */
export async function checkRateReportRecipientsForSave({
  db, locationId, recipients, previouslyConfirmed = [], confirmExternal = false,
}) {
  const prior = new Set((previouslyConfirmed || []).map(normaliseRecipient))
  const refused = []
  const needsConfirmation = []
  const confirmedExternal = []
  let lookupFailed = false
  for (const { email, kind } of await classifyRateReportRecipients({ db, locationId, recipients })) {
    if (kind === 'rate_viewer') continue
    if (kind === 'lookup_failed') { lookupFailed = true; continue }
    if (kind === 'not_rate_viewer') { refused.push(email); continue }
    const key = normaliseRecipient(email)
    if (prior.has(key) || confirmExternal) {
      if (!confirmedExternal.includes(key)) confirmedExternal.push(key)
    } else {
      needsConfirmation.push(email)
    }
  }
  return { refused, needsConfirmation, confirmedExternal, lookupFailed }
}
