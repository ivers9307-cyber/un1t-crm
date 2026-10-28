import { describe, it, expect } from 'vitest'
import { classForgivenessFrom, forgivenessRuleFor, decideForgiveness, FORGIVENESS_RULES, forgivenessReason } from './class-fees-forgiveness.js'

const DUB = 'Europe/Dublin'
const DAY = 86_400_000
const at = (iso) => Date.parse(iso)
const iso = (ms) => new Date(ms).toISOString()

const ALL_ON = classForgivenessFrom({ forgiveness: { swap: true, spot_refilled: true, new_member: true, first_offence: true, monthly_cap: true, monthly_cap_count: 2 } })
const ONLY = (rule) => classForgivenessFrom({ forgiveness: {
  swap: rule === 'swap', spot_refilled: rule === 'spot_refilled', new_member: rule === 'new_member',
  first_offence: rule === 'first_offence', monthly_cap: rule === 'monthly_cap', monthly_cap_count: 2,
} })
const noFacts = () => ({ prior: [], clientCreatedAt: new Map(), trialAt: new Map(), laterBookings: [], eventBookings: [] })

const CLASS = '2026-10-28T18:30:00.000Z'
const late = (over = {}) => ({ bookingId: 'b1', un1tUserId: 'u1', eventId: 'e1', kind: 'late_cancel', startsAt: CLASS, cancelledAt: '2026-10-28T17:45:00.000Z', ...over })
const noShow = (over = {}) => ({ bookingId: 'b1', un1tUserId: 'u1', eventId: 'e1', kind: 'no_show', startsAt: CLASS, cancelledAt: null, ...over })
const decide1 = (offence, facts, rules) => decideForgiveness({ offences: [offence], facts, rules, zone: DUB }).get(offence.bookingId)

describe('classForgivenessFrom', () => {
  it('defaults: swap, new member and first offence on; spot refilled and the monthly cap off', () => {
    const r = classForgivenessFrom(undefined)
    expect(r).toEqual({
      swap: { on: true, minutes: 30 },
      spotRefilled: { on: false },
      newMember: { on: true, days: 14 },
      firstOffence: { on: true, days: 60 },
      monthlyCap: { on: false, cap: 2 },
    })
  })

  it('reads switches and bounded numbers; anything out of range takes the default', () => {
    const r = classForgivenessFrom({ forgiveness: { swap: false, first_offence_days: 90, new_member_days: 500, monthly_cap: true, monthly_cap_count: 'x' } })
    expect(r.swap.on).toBe(false)
    expect(r.firstOffence.days).toBe(90)
    expect(r.newMember.days).toBe(14)
    expect(r.monthlyCap).toEqual({ on: true, cap: 2 })
  })

  it('has a reason for every rule', () => {
    for (const rule of FORGIVENESS_RULES) expect(forgivenessReason(rule)).toMatch(/automatic/)
  })
})

describe('forgivenessRuleFor', () => {
  const none = { swapped: false, spotRefilled: false, isNewOrTrial: false, priorOffences: 1, feesThisMonth: 0 }
  it('a swap and a refilled spot only ever forgive a late cancel', () => {
    expect(forgivenessRuleFor({ kind: 'late_cancel' }, { ...none, swapped: true }, ALL_ON)).toBe('swap')
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, swapped: true }, ALL_ON)).toBeNull()
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, spotRefilled: true }, ALL_ON)).toBeNull()
  })
  it('checks the rules in order', () => {
    expect(forgivenessRuleFor({ kind: 'late_cancel' }, { swapped: true, spotRefilled: true, isNewOrTrial: true, priorOffences: 0, feesThisMonth: 9 }, ALL_ON)).toBe('swap')
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, isNewOrTrial: true, priorOffences: 0 }, ALL_ON)).toBe('new_member')
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, priorOffences: 0 }, ALL_ON)).toBe('first_offence')
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, feesThisMonth: 2 }, ALL_ON)).toBe('monthly_cap')
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, feesThisMonth: 1 }, ALL_ON)).toBeNull()
  })
  it('a rule that is off never forgives', () => {
    expect(forgivenessRuleFor({ kind: 'no_show' }, { ...none, priorOffences: 0 }, ONLY('swap'))).toBeNull()
  })
})

describe('decideForgiveness', () => {
  it('swap: another booking within the window after the cancel; not after it, and not the same class', () => {
    const rules = ONLY('swap')
    const cancelMs = at('2026-10-28T17:45:00.000Z')
    const facts = (createdMs, eventId = 'e2') => ({ ...noFacts(), laterBookings: [{ un1t_id: 'b9', un1t_user_id: 'u1', event_id: eventId, status: 'booked', remote_created_at: iso(createdMs) }] })
    expect(decide1(late(), facts(cancelMs + 45_000), rules)).toBe('swap')
    expect(decide1(late(), facts(cancelMs + 31 * 60_000), rules)).toBeNull()
    expect(decide1(late(), facts(cancelMs + 60_000, 'e1'), rules)).toBeNull()
    expect(decide1(late(), facts(cancelMs - 60_000), rules)).toBeNull()
  })

  it('spot refilled: someone else booked the class after the cancel', () => {
    const rules = ONLY('spot_refilled')
    const f = (status, user = 'u2', when = '2026-10-28T18:00:00.000Z') => ({ ...noFacts(), eventBookings: [{ un1t_id: 'bx', un1t_user_id: user, event_id: 'e1', status, remote_created_at: when }] })
    expect(decide1(late(), f('attended'), rules)).toBe('spot_refilled')
    expect(decide1(late(), f('cancelled'), rules)).toBeNull()
    expect(decide1(late(), f('booked', 'u1'), rules)).toBeNull()
    expect(decide1(late(), f('booked', 'u2', '2026-10-28T17:00:00.000Z'), rules)).toBeNull()
  })

  it('new member: account under 14 days old at the class, or a €0 trial pack in the 14 days before', () => {
    const rules = ONLY('new_member')
    const start = at(CLASS)
    expect(decide1(noShow(), { ...noFacts(), clientCreatedAt: new Map([['u1', start - 13 * DAY]]) }, rules)).toBe('new_member')
    expect(decide1(noShow(), { ...noFacts(), clientCreatedAt: new Map([['u1', start - 15 * DAY]]) }, rules)).toBeNull()
    expect(decide1(noShow(), { ...noFacts(), trialAt: new Map([['u1', [start - 3 * DAY]]]) }, rules)).toBe('new_member')
    expect(decide1(noShow(), { ...noFacts(), trialAt: new Map([['u1', [start - 20 * DAY]]]) }, rules)).toBeNull()
  })

  it('first offence: none in the 60 days before; a swap is not an offence; an older one has expired', () => {
    const rules = ONLY('first_offence')
    const prior = (daysBefore, extra = {}) => ({ un1t_booking_id: 'old', un1t_user_id: 'u1', starts_at: iso(at(CLASS) - daysBefore * DAY), class_day: '2026-09-01', status: 'charged', penalty: 'fee', waive_rule: null, ...extra })
    expect(decide1(noShow(), noFacts(), rules)).toBe('first_offence')
    expect(decide1(noShow(), { ...noFacts(), prior: [prior(30)] }, rules)).toBeNull()
    expect(decide1(noShow(), { ...noFacts(), prior: [prior(61)] }, rules)).toBe('first_offence')
    expect(decide1(noShow(), { ...noFacts(), prior: [prior(30, { status: 'waived', waive_rule: 'swap' })] }, rules)).toBe('first_offence')
    // A re-run sees its own row among the prior fees: never counted against itself.
    expect(decide1(noShow(), { ...noFacts(), prior: [prior(0, { un1t_booking_id: 'b1' })] }, rules)).toBe('first_offence')
  })

  it('the same night: the earlier class is the first offence and the later one is charged', () => {
    const rules = ONLY('first_offence')
    const offences = [
      noShow({ bookingId: 'late-class', startsAt: '2026-10-28T19:30:00.000Z' }),
      noShow({ bookingId: 'early-class', startsAt: '2026-10-28T07:00:00.000Z' }),
    ]
    const d = decideForgiveness({ offences, facts: noFacts(), rules, zone: DUB })
    expect(d.get('early-class')).toBe('first_offence')
    expect(d.get('late-class')).toBeNull()
  })

  it('monthly cap: fees already owed or paid this calendar month, studio time', () => {
    const rules = ONLY('monthly_cap')
    const owed = (n, month = '2026-10', status = 'charged') => Array.from({ length: n }, (_, i) => ({ un1t_booking_id: `p${i}`, un1t_user_id: 'u1', starts_at: '2026-10-02T10:00:00.000Z', class_day: `${month}-02`, status, penalty: 'fee', waive_rule: null }))
    expect(decide1(noShow(), { ...noFacts(), prior: owed(2) }, rules)).toBe('monthly_cap')
    expect(decide1(noShow(), { ...noFacts(), prior: owed(1) }, rules)).toBeNull()
    expect(decide1(noShow(), { ...noFacts(), prior: owed(2, '2026-09') }, rules)).toBeNull()
    expect(decide1(noShow(), { ...noFacts(), prior: owed(2, '2026-10', 'waived') }, rules)).toBeNull()
  })
})
