// PIPE3.3 — one router decides which Stillorgan board a contact sits on.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
import { describe, it, expect } from 'vitest'
import { routeContact, BOARD_KEYS, CLAIM_BOARD_MODULES, OFFER_MODULES } from './router.js'
import { parseOfferConfig } from './offer-config.js'
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


// PIPEBUILD.3b — the router also takes board descriptors and places offer boards first.
const cold = { ...trialer, pack_customer_at: null, trial_credits_remaining: 0, pipeline_dismissed_at: iso(T0 + 2 * DAY_MS) }
const back = { ...cold, last_lead_source_at: iso(T0 + 3 * DAY_MS) }
const lead = { glofox_membership_status: 'lead', joined_at: iso(T0) }
const trialC = { glofox_membership_status: 'trial', joined_at: iso(T0) }
const member = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS), joined_at: iso(T0) }
const goldenCases = [
  [lead, { paid: null, programme: null }, T0 + DAY_MS, ALL],
  [trialer, { paid, programme: null }, T0 + DAY_MS, ALL],
  [trialer, { paid, programme }, T0 + DAY_MS, ALL],
  [trialC, { paid: null, programme }, T0 + DAY_MS, ALL],
  [cold, { paid, programme }, T0 + 3 * DAY_MS, ALL],
  [back, { paid, programme: null }, T0 + 4 * DAY_MS, ALL],
  [{ glofox_membership_status: 'trial', gympass_member_id: 'g1' }, { paid, programme }, T0 + DAY_MS, ALL],
  [trialC, { paid, programme: null }, T0 + 80 * DAY_MS, ALL],
  [member, { paid, programme: null }, T0 + 70 * DAY_MS, ALL],
  [member, { paid, programme: null }, T0 + 20 * DAY_MS, ALL],
  [trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition'])],
  [trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition', 'programmes'])],
  [trialer, null, T0 + DAY_MS, ALL],
  [trialer, { paid, programme }, T0 + DAY_MS, null],
]
const descriptorsFor = (set, paidModule) => [...set].map((key) => ({
  key, module: key === 'paid_trial' ? paidModule : key, board_type: key === 'acquisition' ? 'acquisition' : 'claim', priority: 0, config: null,
}))

const OFFER_START = T0
const offerClaim = { start: OFFER_START, end: OFFER_START + 14 * DAY_MS, source: 'tag' }
const offerCfg = (key) => parseOfferConfig({
  entry: { type: 'tag', values: ['x'] },
  stages: [{ role: 'new', slug: `${key}_new`, name: 'New' }, { role: 'done', slug: `${key}_done`, name: 'Done' }],
}, { boardKey: key }).config
const offerBoard = (key, priority) => ({ key, module: 'offer', board_type: 'offer', priority, config: offerCfg(key) })
const acqD = { key: 'acquisition', module: 'acquisition', board_type: 'acquisition', priority: 0, config: null }
const paidD = { key: 'paid_trial', module: 'paid_trial', board_type: 'claim', priority: 0, config: null }

describe('routeContact — board descriptors and offer boards', () => {
  it('goldenSetVsDescriptors', () => {
    for (const [c, claims, now, set] of goldenCases) {
      const want = routeContact(c, claims, now, set)
      for (const paidModule of ['paid_trial', 'paid_trial_un1t']) {
        expect(routeContact(c, claims, now, set && descriptorsFor(set, paidModule))).toEqual(want)
      }
    }
  })
  it('exports OFFER_MODULES', () => {
    expect([...OFFER_MODULES]).toEqual(['offer'])
  })
  it('offerBeatsPaid', () => {
    const offers = new Map([['b_one', offerClaim]])
    expect(routeContact(trialer, { paid, programme: null, offers }, T0 + DAY_MS, [acqD, paidD, offerBoard('b_one', 5)]))
      .toEqual({ boardKey: 'b_one', slug: 'b_one_new' })
  })
  it('offerPriorityThenKey', () => {
    const offers = new Map([['b_a', offerClaim], ['b_b', offerClaim], ['b_c', offerClaim]])
    const boards = [acqD, offerBoard('b_b', 2), offerBoard('b_c', 1), offerBoard('b_a', 2)]
    expect(routeContact(trialC, { offers }, T0 + DAY_MS, boards).boardKey).toBe('b_c')
    const tie = [acqD, offerBoard('b_b', 2), offerBoard('b_a', 2)]
    expect(routeContact(trialC, { offers }, T0 + DAY_MS, tie).boardKey).toBe('b_a')
  })
  it('deadOfferFallsThrough', () => {
    const dead = new Map([['b_one', offerClaim]])
    const late = T0 + 200 * DAY_MS
    expect(routeContact(trialC, { paid: null, programme, offers: dead }, T0 + DAY_MS, [acqD, offerBoard('b_two', 1), offerBoard('b_one', 2), { key: 'programmes', module: 'programmes', board_type: 'claim', priority: 0, config: null }]).boardKey).toBe('b_one')
    expect(routeContact(trialC, { offers: dead }, late, [acqD, offerBoard('b_one', 1)]).boardKey).toBe('acquisition')
    // no claim for a board, or an unparsed config, skips it without throwing
    expect(routeContact(trialC, { paid: null, programme, offers: new Map() }, T0 + DAY_MS, [acqD, offerBoard('b_one', 1), { key: 'programmes', module: 'programmes', board_type: 'claim', priority: 0, config: null }]).boardKey).toBe('programmes')
    const bad = { ...offerBoard('b_one', 1), config: null }
    expect(routeContact(trialC, { offers: dead }, T0 + DAY_MS, [acqD, bad]).boardKey).toBe('acquisition')
  })
  it('coldBeatsOffer', () => {
    const offers = new Map([['b_one', offerClaim]])
    expect(routeContact(cold, { offers }, T0 + 3 * DAY_MS, [acqD, offerBoard('b_one', 1)])).toEqual({ boardKey: 'acquisition', slug: 'cold_lead' })
  })
})
