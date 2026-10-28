// FEES.2 — automatic forgiveness for class fees (Richard, 28 Oct 2026).
// Each rule is switchable per studio at
// locations.settings.un1t_online.fees.forgiveness. A forgiven fee is still
// written, as status 'waived' with waive_rule naming the rule, so staff see
// what was forgiven and why.
//
// The rules, checked in this order (the first that applies wins):
//   swap           a late cancel followed within `minutes` by a booking into
//                  another class at the studio: a move, not an offence.
//                  On by default (30 minutes).
//   spot_refilled  a late cancel whose spot someone else booked after the
//                  cancel. Off by default.
//   new_member     the member's un1t.online account is under `days` old at
//                  the class, or they bought a €0 pack (the trial) within
//                  `days` before it. On by default (14 days).
//   first_offence  no other offence (a swap is not one) in the `days` before
//                  the class. On by default (60 days).
//   monthly_cap    the member already owes or paid `cap` fees for classes in
//                  the same calendar month. Off by default.
//
// classForgivenessFrom and forgivenessRuleFor are pure; loadForgivenessFacts
// is the one batched read the night's run makes.

import { dateKeyIn } from './location-time.js'

export const FORGIVENESS_RULES = Object.freeze(['swap', 'spot_refilled', 'new_member', 'first_offence', 'monthly_cap'])

export const FORGIVENESS_DEFAULTS = Object.freeze({
  swap: Object.freeze({ on: true, minutes: 30 }),
  spotRefilled: Object.freeze({ on: false }),
  newMember: Object.freeze({ on: true, days: 14 }),
  firstOffence: Object.freeze({ on: true, days: 60 }),
  monthlyCap: Object.freeze({ on: false, cap: 2 }),
})

const RULE_TEXT = Object.freeze({
  swap: 'Moved to another class (automatic)',
  spot_refilled: 'Spot was taken by someone else (automatic)',
  new_member: 'New member or on a trial (automatic)',
  first_offence: 'First offence, a warning only (automatic)',
  monthly_cap: 'Monthly fee limit reached (automatic)',
})
export const forgivenessReason = (rule) => RULE_TEXT[rule] ?? 'Waived automatically'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)
const flag = (v, d) => (typeof v === 'boolean' ? v : d)

/**
 * The fees block (locations.settings.un1t_online.fees) → the rules. A missing
 * rule takes its default; an unreadable value takes the default too.
 */
export function classForgivenessFrom(feesBlock) {
  const f = isObj(feesBlock) && isObj(feesBlock.forgiveness) ? feesBlock.forgiveness : {}
  const D = FORGIVENESS_DEFAULTS
  return {
    swap: { on: flag(f.swap, D.swap.on), minutes: intIn(f.swap_minutes, 5, 240, D.swap.minutes) },
    spotRefilled: { on: flag(f.spot_refilled, D.spotRefilled.on) },
    newMember: { on: flag(f.new_member, D.newMember.on), days: intIn(f.new_member_days, 1, 90, D.newMember.days) },
    firstOffence: { on: flag(f.first_offence, D.firstOffence.on), days: intIn(f.first_offence_days, 7, 365, D.firstOffence.days) },
    monthlyCap: { on: flag(f.monthly_cap, D.monthlyCap.on), cap: intIn(f.monthly_cap_count, 1, 31, D.monthlyCap.cap) },
  }
}

/**
 * The rule that forgives one offence, or null.
 * @param {{ kind: 'late_cancel'|'no_show' }} offence
 * @param {{ swapped: boolean, spotRefilled: boolean, isNewOrTrial: boolean,
 *   priorOffences: number, feesThisMonth: number }} facts
 * @param {ReturnType<typeof classForgivenessFrom>} rules
 */
export function forgivenessRuleFor(offence, facts, rules) {
  const late = offence?.kind === 'late_cancel'
  if (late && rules.swap.on && facts.swapped) return 'swap'
  if (late && rules.spotRefilled.on && facts.spotRefilled) return 'spot_refilled'
  if (rules.newMember.on && facts.isNewOrTrial) return 'new_member'
  if (rules.firstOffence.on && facts.priorOffences === 0) return 'first_offence'
  if (rules.monthlyCap.on && facts.feesThisMonth >= rules.monthlyCap.cap) return 'monthly_cap'
  return null
}

const DAY_MS = 86_400_000
const ms = (v) => Date.parse(v ?? '')
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
const LIVE = new Set(['booked', 'attended', 'no_show'])
const OWED = ['pending', 'charging', 'charged', 'retry_scheduled', 'outstanding']
const ID_CHUNK = 100
const PAGE = 500

function dbError(what, error) {
  return Object.assign(new Error(`class fees forgiveness: ${what} failed (${error?.code ?? 'no code'})`), { code: error?.code ?? null })
}

/**
 * The facts every rule needs, for a batch of offences at one studio. Throws
 * on a read failure (the run fails the studio and tries again next night:
 * a fee is never charged on facts that could not be read).
 *
 * @param {object} db
 * @param {{ locationId: string, zone: string, rules: ReturnType<typeof classForgivenessFrom>,
 *   offences: Array<{ bookingId: string, un1tUserId: string, eventId: string, kind: string,
 *   startsAt: string, cancelledAt: string|null }> }} args
 * @returns {Promise<{ prior: Array<object>, clientCreatedAt: Map<string, number>,
 *   trialAt: Map<string, number[]>, laterBookings: Array<object>, eventBookings: Array<object> }>}
 */
export async function loadForgivenessFacts(db, { locationId, rules, offences }) {
  const users = [...new Set(offences.map((o) => o.un1tUserId).filter(Boolean))]
  const empty = { prior: [], clientCreatedAt: new Map(), trialAt: new Map(), laterBookings: [], eventBookings: [] }
  if (!users.length) return empty
  const starts = offences.map((o) => ms(o.startsAt)).filter(Number.isFinite)
  const minStart = Math.min(...starts)
  const lookbackDays = Math.max(rules.firstOffence.days, 31)
  const out = { ...empty, clientCreatedAt: new Map(), trialAt: new Map() }

  for (const ids of chunk(users, ID_CHUNK)) {
    // Earlier fees of these members (first offence, monthly cap).
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('class_fees')
        .select('un1t_booking_id, un1t_user_id, starts_at, class_day, status, penalty, waive_rule')
        .eq('location_id', locationId)
        .in('un1t_user_id', ids)
        .gte('starts_at', new Date(minStart - lookbackDays * DAY_MS).toISOString())
        .order('starts_at')
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) throw dbError('prior fees read', error)
      out.prior.push(...(data || []))
      if (!data || data.length < PAGE) break
    }

    if (rules.newMember.on) {
      const { data: clients, error: cErr } = await db
        .from('un1t_clients')
        .select('un1t_user_id, remote_created_at')
        .eq('location_id', locationId)
        .in('un1t_user_id', ids)
        .limit(ID_CHUNK)
      if (cErr) throw dbError('client read', cErr)
      for (const c of clients || []) {
        const t = ms(c.remote_created_at)
        if (Number.isFinite(t)) out.clientCreatedAt.set(c.un1t_user_id, t)
      }
      const { data: tx, error: tErr } = await db
        .from('un1t_transactions')
        .select('un1t_user_id, remote_created_at')
        .eq('location_id', locationId)
        .in('un1t_user_id', ids)
        .eq('amount_cents', 0)
        .eq('product_type', 'pack')
        .gte('remote_created_at', new Date(minStart - rules.newMember.days * DAY_MS).toISOString())
        .order('remote_created_at')
        .limit(PAGE)
      if (tErr) throw dbError('trial read', tErr)
      for (const t of tx || []) {
        const at = ms(t.remote_created_at)
        if (!Number.isFinite(at)) continue
        if (!out.trialAt.has(t.un1t_user_id)) out.trialAt.set(t.un1t_user_id, [])
        out.trialAt.get(t.un1t_user_id).push(at)
      }
    }

    const cancels = offences.filter((o) => o.kind === 'late_cancel' && Number.isFinite(ms(o.cancelledAt)))
    if (rules.swap.on && cancels.length) {
      const lo = Math.min(...cancels.map((o) => ms(o.cancelledAt)))
      const hi = Math.max(...cancels.map((o) => ms(o.cancelledAt))) + rules.swap.minutes * 60_000
      const { data, error } = await db
        .from('un1t_bookings')
        .select('un1t_id, un1t_user_id, event_id, status, remote_created_at')
        .eq('location_id', locationId)
        .in('un1t_user_id', ids)
        .gte('remote_created_at', new Date(lo).toISOString())
        .lte('remote_created_at', new Date(hi).toISOString())
        .order('remote_created_at')
        .limit(PAGE)
      if (error) throw dbError('swap read', error)
      out.laterBookings.push(...(data || []))
    }
  }

  if (rules.spotRefilled.on) {
    const events = [...new Set(offences.filter((o) => o.kind === 'late_cancel').map((o) => o.eventId))]
    for (const ids of chunk(events, ID_CHUNK)) {
      const { data, error } = await db
        .from('un1t_bookings')
        .select('un1t_id, un1t_user_id, event_id, status, remote_created_at')
        .eq('location_id', locationId)
        .in('event_id', ids)
        .order('un1t_id')
        .limit(PAGE)
      if (error) throw dbError('spot read', error)
      out.eventBookings.push(...(data || []))
    }
  }
  return out
}

/**
 * Decide every offence of the batch, oldest class first, so an earlier
 * offence in the same night counts against a later one. Pure.
 *
 * @returns {Map<string, string|null>} booking id → rule (null = charge it)
 */
export function decideForgiveness({ offences, facts, rules, zone }) {
  const decided = new Map()
  const prior = facts.prior.filter((p) => p.penalty === 'fee')
  // A swap is a move, never an offence; every other fee row is one.
  const offenceAt = new Map()
  const feeMonth = new Map()
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v) }
  for (const p of prior) {
    if (p.waive_rule !== 'swap') push(offenceAt, p.un1t_user_id, { at: ms(p.starts_at), booking: p.un1t_booking_id })
    if (OWED.includes(p.status)) push(feeMonth, p.un1t_user_id, { month: String(p.class_day).slice(0, 7), booking: p.un1t_booking_id })
  }

  const ordered = [...offences].sort((a, b) => ms(a.startsAt) - ms(b.startsAt))
  for (const o of ordered) {
    const start = ms(o.startsAt)
    const cancelAt = ms(o.cancelledAt)
    const swapped = o.kind === 'late_cancel' && Number.isFinite(cancelAt) && facts.laterBookings.some((b) =>
      b.un1t_user_id === o.un1tUserId && b.event_id !== o.eventId && b.un1t_id !== o.bookingId
      && ms(b.remote_created_at) >= cancelAt && ms(b.remote_created_at) <= cancelAt + rules.swap.minutes * 60_000)
    const spotRefilled = o.kind === 'late_cancel' && Number.isFinite(cancelAt) && facts.eventBookings.some((b) =>
      b.event_id === o.eventId && b.un1t_user_id !== o.un1tUserId && LIVE.has(String(b.status ?? '').toLowerCase())
      && ms(b.remote_created_at) > cancelAt)
    const created = facts.clientCreatedAt.get(o.un1tUserId)
    const windowMs = rules.newMember.days * DAY_MS
    const isNewOrTrial = (Number.isFinite(created) && start - created < windowMs && start >= created)
      || (facts.trialAt.get(o.un1tUserId) || []).some((t) => t <= start && start - t < windowMs)
    const priorOffences = (offenceAt.get(o.un1tUserId) || [])
      .filter((p) => p.booking !== o.bookingId && p.at < start && start - p.at < rules.firstOffence.days * DAY_MS).length
    const month = dateKeyIn(start, zone).slice(0, 7)
    const feesThisMonth = (feeMonth.get(o.un1tUserId) || []).filter((m) => m.month === month && m.booking !== o.bookingId).length

    const rule = forgivenessRuleFor(o, { swapped, spotRefilled, isNewOrTrial, priorOffences, feesThisMonth }, rules)
    decided.set(o.bookingId, rule)
    if (rule !== 'swap') push(offenceAt, o.un1tUserId, { at: start, booking: o.bookingId })
    if (rule === null) push(feeMonth, o.un1tUserId, { month, booking: o.bookingId })
  }
  return decided
}
