// OWNERDAILY.1 — the headline of the owner's daily briefing (Richard's
// decision, 19 Nov 2026: one daily email carrying revenue, new leads, members,
// and churn and arrears, replacing the two Monday emails). The members and
// churn/arrears half is the existing Studio pulse strip; this is the rest:
//
//   revenue   month to date, through the studio's membership source
//             (revenueMtd: Glofox invoices, or un1t.online's mirror)
//   leads     new contacts added yesterday at the studio
//   trials    paid trials bought yesterday (/trial, both payment rails)
//
// "Yesterday" is the studio's own calendar day. Each figure is best-effort:
// one that cannot be read is null and the email leaves it out, never a zero.
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { dayStrIn, addDaysIn, dayStartMsIn } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const LOG = 'owner-daily'

async function countIn(db, table, column, locationId, startIso, endIso) {
  const { count, error } = await db.from(table)
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .gte(column, startIso)
    .lt(column, endIso)
  if (error) {
    logWarn(LOG, 'daily headline count unreadable', { table, locationId, code: error.code ?? null })
    return null
  }
  return count ?? 0
}

/**
 * @param {object} db  service-role client
 * @param {string} locationId
 * @param {{ nowMs: number, zone: string }} opts  the studio's zone
 * @returns {Promise<{ revenue: { totalCents: number, deltaPct: number|null }|null, newLeads: number|null, trials: number|null, dayLabel: string }>}
 */
export async function fetchDailyHeadline(db, locationId, { nowMs, zone }) {
  const today = dayStrIn(new Date(nowMs), zone)
  const yesterday = addDaysIn(today, -1, zone)
  const startIso = new Date(dayStartMsIn(yesterday, zone)).toISOString()
  const endIso = new Date(dayStartMsIn(today, zone)).toISOString()

  const revenue = (async () => {
    try {
      const m = await membershipReadsFor(db, locationId)
      if (!supportsRead(m, 'revenueMtd')) return null
      const r = await m.reads.revenueMtd(db, locationId, new Date(nowMs), zone)
      if (!r?.success) return null
      return { totalCents: Number(r.data?.totalCents) || 0, deltaPct: Number.isFinite(r.data?.deltaPct) ? r.data.deltaPct : null }
    } catch (err) {
      logWarn(LOG, 'daily headline revenue unreadable', { locationId, err })
      return null
    }
  })()

  const [rev, newLeads, trials] = await Promise.all([
    revenue,
    countIn(db, 'contacts', 'created_at', locationId, startIso, endIso),
    countIn(db, 'trial_purchases', 'paid_at', locationId, startIso, endIso),
  ])
  return { revenue: rev, newLeads, trials, dayLabel: yesterday }
}
