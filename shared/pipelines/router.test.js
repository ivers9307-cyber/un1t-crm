// PIPE3.3 — one router decides which Stillorgan board a contact sits on.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
import { describe, it, expect } from 'vitest'
import { routeContact, BOARD_KEYS, CLAIM_BOARD_MODULES } from './router.js'
import { paidTrialClaim, DAY_MS } from './paid-trial.js'

const T0 = Date.parse('2026-10-30T19:44:05Z')
const iso = (ms) => new Date(ms).toISOString()
const ALL = new Set(['acquisition', 'paid_trial', 'programmes'])
const paid = paidTrialClaim([{ status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 }], T0)
const programme = { claimedAt: T0, source: 'lead_source' }
// The one synced €39 buyer on 2026-10-31: status trial, 10 credits, stamped as a
// pack customer four minutes after the grant (the trial's own credits).
const trialer = { glofox_membership_status: 'trial', joined_at: iso(T0), trial_credits_remaining: 10, pack_customer_at: iso(T0 + 4 * 60_000) }

describe('routeContact', () => {
  it('no claims: the acquisition board, classifyContact\'s slug', () => {
    expect(routeContact({ glofox_membership_status: 'lead', joined_at: iso(T0) }, { paid: null, programme: null }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'new_lead' })
  })
  it('a live paid claim wins over the acquisition pack reading (the 10-credit buyer)', () => {
    expect(routeContact(trialer, { paid, programme: null }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'paid_trial', slug: 'paid_trial_new_lead' })
  })
  it('paid outranks programme when both are live', () => {
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, ALL).boardKey).toBe('paid_trial')
  })
  it('a live programme claim alone goes to Programmes', () => {
    expect(routeContact({ glofox_membership_status: 'trial', joined_at: iso(T0) }, { paid: null, programme }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'programmes', slug: 'programme_lead' })
  })
  it('Cold beats every claim', () => {
    const cold = { ...trialer, pack_customer_at: null, trial_credits_remaining: 0, pipeline_dismissed_at: iso(T0 + 2 * DAY_MS) }
    expect(routeContact(cold, { paid, programme }, T0 + 3 * DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'cold_lead' })
  })
  it('a public re-entry after the dismissal revokes Cold and the claim applies again', () => {
    const back = { ...trialer, pack_customer_at: null, trial_credits_remaining: 0, pipeline_dismissed_at: iso(T0 + 2 * DAY_MS), last_lead_source_at: iso(T0 + 3 * DAY_MS) }
    expect(routeContact(back, { paid, programme: null }, T0 + 4 * DAY_MS, ALL).boardKey).toBe('paid_trial')
  })
  it('Gympass beats every claim', () => {
    expect(routeContact({ glofox_membership_status: 'trial', gympass_member_id: 'g1' }, { paid, programme }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'gympass' })
  })
  it('an expired claim falls back to acquisition (dormant after the quiet spell)', () => {
    expect(routeContact({ glofox_membership_status: 'trial', joined_at: iso(T0) }, { paid, programme: null }, T0 + 80 * DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'dormant' })
  })
  it('a member whose paid claim has aged out lands on the acquisition Member pile', () => {
    const m = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS), joined_at: iso(T0) }
    expect(routeContact(m, { paid, programme: null }, T0 + 70 * DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'member' })
    expect(routeContact(m, { paid, programme: null }, T0 + 20 * DAY_MS, ALL)).toEqual({ boardKey: 'paid_trial', slug: 'paid_trial_converted' })
  })
  it('a claim for a board the location does not run is ignored', () => {
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition'])).boardKey).toBe('acquisition')
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition', 'programmes'])).boardKey).toBe('programmes')
  })
  it('missing claims object or boards set behaves as "no claims"', () => {
    expect(routeContact(trialer, null, T0 + DAY_MS, ALL).boardKey).toBe('acquisition')
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, null).boardKey).toBe('acquisition')
  })
  it('exports the three keys and the two claim modules', () => {
    expect(Object.values(BOARD_KEYS).sort()).toEqual(['acquisition', 'paid_trial', 'programmes'])
    expect([...CLAIM_BOARD_MODULES].sort()).toEqual(['paid_trial', 'programmes'])
  })
})


// HATCH39 — the un1t path hands the router its own acquisition classify
// (acquisition_un1t.classify: TRIALDONE.2), for the Cold/Gympass check and the fallback.
describe('routeContact — classifyAcquisition option', () => {
  const stub = () => 'trial_done'
  it('the fallback uses the given acquisition classify', () => {
    expect(routeContact({ glofox_membership_status: 'lead' }, { paid: null, programme: null }, T0, ALL, { classifyAcquisition: stub }))
      .toEqual({ boardKey: 'acquisition', slug: 'trial_done' })
  })
  it('a Cold or Gympass answer from the given classify still beats a live claim', () => {
    const cold = () => 'cold_lead'
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, ALL, { classifyAcquisition: cold })).toEqual({ boardKey: 'acquisition', slug: 'cold_lead' })
    const gym = () => 'gympass'
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, ALL, { classifyAcquisition: gym })).toEqual({ boardKey: 'acquisition', slug: 'gympass' })
  })
  it('a live claim still wins over an ordinary answer from the given classify', () => {
    expect(routeContact(trialer, { paid, programme: null }, T0 + DAY_MS, ALL, { classifyAcquisition: stub }).boardKey).toBe('paid_trial')
  })
})
