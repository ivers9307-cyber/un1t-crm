// PIPE3.2 — the Programmes board module (50+ and pre/post natal leads).
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
import { describe, it, expect } from 'vitest'
import { stages, requiredFields, classify, programmeClaimLive, matchProgrammeSignal } from './programmes.js'
import { DAY_MS } from './paid-trial.js'

const T0 = Date.parse('2026-10-31T22:28:37Z')
const iso = (ms) => new Date(ms).toISOString()
const RULES = { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] }
const claim = { claimedAt: T0 }

describe('stages', () => {
  it('three on-funnel columns', () => {
    expect(stages.map((s) => [s.slug, s.name, s.display_order])).toEqual([
      ['programme_lead', 'Lead', 701], ['programme_first_class', '1st Class Done', 702], ['programme_converted', 'Converted', 703],
    ])
    expect(stages.every((s) => s.is_dormant === false)).toBe(true)
  })
  it('declares the matching inputs on top of the acquisition set', () => {
    for (const f of ['lead_source', 'last_lead_source', 'glofox_membership_plan', 'last_lead_source_at', 'glofox_membership_status', 'recent_bookings', 'converted_at', 'pack_customer_at']) {
      expect(requiredFields, `missing ${f}`).toContain(f)
    }
  })
})

describe('matchProgrammeSignal', () => {
  it('the /50plus lead source, dated at last_lead_source_at', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0) }, RULES, T0 + 1000)).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
  it('a lead source with no timestamp is dated now', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus' }, RULES, T0)).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
  it('case-insensitive; falls back to lead_source when last_lead_source is null', () => {
    expect(matchProgrammeSignal({ last_lead_source: null, lead_source: 'META_50PLUS' }, RULES, T0)).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
  it('a non-matching last_lead_source does not fall back to lead_source', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_trial', lead_source: 'meta_50plus' }, RULES, T0)).toBeNull()
  })
  it('the Elites Trial plan, dated now; "Elite Membership" does not match', () => {
    expect(matchProgrammeSignal({ glofox_membership_plan: 'The Elites Trial' }, RULES, T0)).toEqual({ claimedAt: T0, source: 'glofox_plan' })
    expect(matchProgrammeSignal({ glofox_membership_plan: 'Elite Membership' }, RULES, T0)).toBeNull()
    expect(matchProgrammeSignal({ glofox_membership_plan: '3 Month Elites Membership (Plan 1)' }, RULES, T0)).toBeNull()
  })
  it('a lead-source match outranks a plan match', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0 - DAY_MS), glofox_membership_plan: 'The Elites Trial' }, RULES, T0).source).toBe('lead_source')
  })
  it('empty or missing rules match nobody', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus' }, { lead_sources: [], glofox_plan_patterns: [] }, T0)).toBeNull()
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus' }, null, T0)).toBeNull()
    expect(matchProgrammeSignal(null, RULES, T0)).toBeNull()
  })
})

describe('classify', () => {
  it('lead → 1st class done → converted, counted from the claim', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + DAY_MS, claim)).toBe('programme_lead')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 + DAY_MS) }, T0 + 2 * DAY_MS, claim)).toBe('programme_first_class')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 - 300 * DAY_MS) }, T0 + DAY_MS, claim)).toBe('programme_lead')
    expect(classify({ glofox_membership_status: 'member', converted_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('programme_converted')
    expect(classify({ glofox_membership_status: 'trial', pack_customer_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('programme_converted')
  })
  it('a second class does not move them', () => {
    const b = (ms) => ({ status: 'BOOKED', attended: true, time_start: Math.floor(ms / 1000) })
    expect(classify({ recent_bookings: [b(T0 + DAY_MS), b(T0 + 3 * DAY_MS)], last_attended_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('programme_first_class')
  })
  it('throws without a claim', () => { expect(() => classify({}, T0, null)).toThrow(TypeError) })
})

describe('programmeClaimLive', () => {
  it('a lead who never books falls off 60 days after the claim', () => {
    expect(programmeClaimLive(claim, {}, T0 + 60 * DAY_MS - 1)).toBe(true)
    expect(programmeClaimLive(claim, {}, T0 + 60 * DAY_MS)).toBe(false)
  })
  it('a class restarts the clock; a 2025 claim is dead on arrival', () => {
    expect(programmeClaimLive(claim, { last_attended_at: iso(T0 + 20 * DAY_MS) }, T0 + 80 * DAY_MS - 1)).toBe(true)
    expect(programmeClaimLive(claim, { last_attended_at: iso(T0 + 20 * DAY_MS) }, T0 + 80 * DAY_MS)).toBe(false)
    expect(programmeClaimLive({ claimedAt: Date.parse('2025-09-05T22:09:11Z') }, {}, T0)).toBe(false)
  })
  it('converted: 60 days from converted_at', () => {
    const c = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS) }
    expect(programmeClaimLive(claim, c, T0 + 65 * DAY_MS - 1)).toBe(true)
    expect(programmeClaimLive(claim, c, T0 + 65 * DAY_MS)).toBe(false)
  })
  it('null claim is never live', () => { expect(programmeClaimLive(null, {}, T0)).toBe(false) })
})


// PIPE3 fix pass (review #7) — same for the Programmes board.
describe('programmeClaimLive — a re-joining ex-member', () => {
  it('an old converted_at never counts against the new claim', () => {
    const c = { glofox_membership_status: 'member', converted_at: iso(T0 - 700 * DAY_MS) }
    expect(programmeClaimLive(claim, c, T0 + 10 * DAY_MS)).toBe(true)
    expect(programmeClaimLive(claim, c, T0 + 60 * DAY_MS)).toBe(false)
  })
})
