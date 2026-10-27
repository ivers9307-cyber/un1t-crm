// CARDLENS.9 — the contact header follows the studio the page looks at: the
// acting studio, or 'all'. Pure; the page passes today's figures as `base`
// (Glofox, or the person aggregate, with un1t.online arrears merged in) and
// studioMemberships() rows.
//
//   a Glofox studio      → today's Glofox figures, Glofox arrears only, that
//                          studio's deals
//   a un1t.online studio → that studio's counters, overdue and value
//   a CRM-only studio    → nothing to count there (null, never 0)
//   'all'                → attendance and value summed over the studios that
//                          know them, the latest class, the merged arrears
//   no memberships / a lens not among them → `base`, exactly as before
//   one studio → `base` too, except a un1t.online-only member gets that
//                studio's attendance, last class and value
import { un1tHeaderRisk } from './contact-un1t-billing'

const known = (v) => typeof v === 'number' && Number.isFinite(v)
const latest = (...isos) => isos.filter(Boolean).sort().pop() || null

/**
 * @param {object} a
 * @param {Array<object>} a.memberships  studioMemberships()
 * @param {string|null} a.lensId         a location id, or 'all'
 * @param {{ attended, lastAttendedAt, arrearsCents, glofoxArrearsCents, ltvCents, deals, un1t }} a.base
 * @param {Array<{ location_id: string }>} a.deals
 */
export function lensMetrics({ memberships = [], lensId, base, deals = [] }) {
  if (!memberships.length) return { ...base }
  // One studio: today's figures. A un1t.online-only member swaps in that
  // studio's counters (the Glofox columns are empty for them); arrears and the
  // un1t flags stay today's merged ones.
  if (memberships.length < 2) {
    const only = memberships[0]
    if (only.platform !== 'un1t_online') return { ...base }
    return { ...base, attended: only.attended30d, lastAttendedAt: only.lastAttendedAt, ltvCents: only.ltvCents }
  }
  if (lensId === 'all') {
    const others = memberships.filter((m) => m.platform !== 'glofox')
    const sum = (start, key) => others.reduce((acc, m) => (known(m[key]) ? (acc ?? 0) + m[key] : acc), start)
    return {
      ...base,
      attended: sum(known(base.attended) ? base.attended : null, 'attended30d'),
      lastAttendedAt: latest(base.lastAttendedAt, ...others.map((m) => m.lastAttendedAt)),
      ltvCents: sum(known(base.ltvCents) ? base.ltvCents : null, 'ltvCents'),
    }
  }
  const target = memberships.find((m) => m.locationId === lensId)
  if (!target) return { ...base }
  const dealsHere = deals.filter((d) => d?.location_id === lensId).length
  if (target.platform === 'glofox') {
    return { ...base, arrearsCents: base.glofoxArrearsCents ?? null, deals: dealsHere, un1t: null }
  }
  if (target.platform === 'un1t_online') {
    return {
      ...base,
      attended: target.attended30d,
      lastAttendedAt: target.lastAttendedAt,
      ltvCents: target.ltvCents,
      arrearsCents: target.owedCents,
      deals: dealsHere,
      un1t: target.overdue ? { overdue: true, amountUnreported: Boolean(target.amountUnreported), amountNotEur: false } : null,
    }
  }
  return { ...base, attended: null, lastAttendedAt: null, ltvCents: null, arrearsCents: null, deals: dealsHere, un1t: null }
}

/**
 * The header's risk chip for the lens. Named with its studio (studioNameMap
 * short names) when the person has two or more studios.
 *
 * @param {object} a
 * @param {string|null} a.lensId
 * @param {Array<object>} a.memberships
 * @param {object|null} a.glofoxOverdue  the Glofox chase-list chip, or null
 * @param {object|null} a.glofoxChurn    the radar's at-risk chip, or null
 * @param {object|null} a.un1tBilling    loadUn1tBilling()
 * @param {Record<string,string>} a.names
 */
export function lensRisk({ lensId, memberships = [], glofoxOverdue, glofoxChurn, un1tBilling, names = {} }) {
  const multi = memberships.length >= 2
  const glofoxId = memberships.find((m) => m.platform === 'glofox')?.locationId || null
  const named = (risk, locationId) => (risk && multi && names[locationId] ? { ...risk, label: `${risk.label} · ${names[locationId]}` } : risk)
  const un1tAt = (locationId) => {
    const studios = (un1tBilling?.studios || []).filter((s) => s.locationId === locationId)
    return un1tHeaderRisk({ overdue: studios.some((s) => (s.pastDues || []).length > 0), studios })
  }
  // One studio (or none): today's chain, unnamed.
  const target = multi && lensId && lensId !== 'all' ? memberships.find((m) => m.locationId === lensId) : null
  if (target?.platform === 'glofox') return named(glofoxOverdue || glofoxChurn || null, target.locationId)
  if (target?.platform === 'un1t_online') return named(un1tAt(target.locationId), target.locationId)
  if (target) return null
  if (glofoxOverdue) return named(glofoxOverdue, glofoxId)
  const overdueStudio = (un1tBilling?.studios || []).find((s) => (s.pastDues || []).length > 0)
  if (un1tBilling?.overdue && overdueStudio) return named(un1tHeaderRisk(un1tBilling), overdueStudio.locationId)
  return named(glofoxChurn || null, glofoxId)
}
