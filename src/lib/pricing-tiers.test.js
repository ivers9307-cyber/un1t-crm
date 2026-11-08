// TIERS.1 — pricing tiers: the schema, which tier a booking gets, the sold
// count (people, held places only), the fee swap, and the public block that
// never carries a count.
import { describe, it, expect, vi } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const {
  PricingTiersSchema, resolvePricingTiers, tierIsOpen, resolveTier, loadSoldByTier, applyTierPricing,
  publicPricing, tierPriceLabel, groupPriceLabel, effectiveNonMemberFee, canonicalTiers,
} = await import('./pricing-tiers.js')

const NOW = Date.parse('2026-11-15T12:00:00Z')
const early = { id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }
const dec = { id: 'dec', name: 'Before December', price_cents: 3000, ends_at: '2026-12-01T00:00:00Z' }
const group = { id: 'group', name: 'Groups', price_cents: 2800, min_people: 3 }
const std = { id: 'std', name: 'Standard', price_cents: 3500 }
const RACE = { id: 'e1', non_member_fee_cents: 3500, pricing_tiers: [early, group, std] }

describe('PricingTiersSchema', () => {
  it('accepts an ordered list and rejects duplicate ids, nine tiers, and an end before its start', () => {
    expect(PricingTiersSchema.safeParse([early, dec, group, std]).success).toBe(true)
    expect(PricingTiersSchema.safeParse([early, { ...std, id: 'early' }]).success).toBe(false)
    expect(PricingTiersSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: 'T', price_cents: 100 }))).success).toBe(false)
    expect(PricingTiersSchema.safeParse([{ id: 'x', name: 'X', price_cents: 100, starts_at: '2026-12-02T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' }]).success).toBe(false)
  })
  it('resolvePricingTiers is [] for null or junk', () => {
    expect(resolvePricingTiers({ pricing_tiers: null })).toEqual([])
    expect(resolvePricingTiers({ pricing_tiers: 'no' })).toEqual([])
    expect(resolvePricingTiers(RACE)).toHaveLength(3)
  })
})

describe('resolveTier', () => {
  it('the first open tier with room that fits the group', () => {
    expect(resolveTier({ tiers: [early, group, std], nowMs: NOW, headcount: 1, soldByTier: {} })?.id).toBe('early')
    expect(resolveTier({ tiers: [early, group, std], nowMs: NOW, headcount: 1, soldByTier: { early: 20 } })?.id).toBe('std')
  })
  it('a group that does not fit moves whole to the next tier', () => {
    const t = resolveTier({ tiers: [early, group, std], nowMs: NOW, headcount: 4, soldByTier: { early: 18 } })
    expect(t?.id).toBe('group')
  })
  it('a closed window is skipped', () => {
    expect(tierIsOpen(dec, Date.parse('2026-12-01T00:00:01Z'))).toBe(false)
    expect(tierIsOpen(dec, Date.parse('2026-11-30T23:59:59Z'))).toBe(true)
    expect(resolveTier({ tiers: [dec, std], nowMs: Date.parse('2026-12-01T00:00:01Z'), headcount: 1, soldByTier: {} })?.id).toBe('std')
    const future = { id: 'f', name: 'Later', price_cents: 100, starts_at: '2027-01-01T00:00:00Z' }
    expect(resolveTier({ tiers: [future], nowMs: NOW, headcount: 1, soldByTier: {} })).toBeNull()
  })
  it('a group tier needs the headcount', () => {
    expect(resolveTier({ tiers: [group], nowMs: NOW, headcount: 2, soldByTier: {} })).toBeNull()
    expect(resolveTier({ tiers: [group], nowMs: NOW, headcount: 3, soldByTier: {} })?.id).toBe('group')
  })
})

function soldDb(rows, { error = null } = {}) {
  return fakeDb((q) => {
    if (q.table !== 'race_registrations') return { data: null, error: null }
    if (error) return { data: null, error }
    const range = q.ops.find((o) => o[0] === 'range')
    return { data: range ? rows.slice(range[1], range[2] + 1) : rows, error: null }
  })
}
const held = (tier, size, over = {}) => ({ id: `${tier}-${size}-${Math.random()}`, status: 'confirmed', registered_at: '2026-11-01T00:00:00Z', pricing_tier_id: tier, team: { size }, ...over })

describe('loadSoldByTier', () => {
  it('sums team sizes per tier for rows holding a place; a lapsed unpaid entry does not count', async () => {
    const rows = [held('early', 2), held('early', 1), held('std', 4), held('early', 3, { status: 'pending_payment', registered_at: '2026-01-01T00:00:00Z' })]
    const r = await loadSoldByTier(soldDb(rows), { eventId: 'e1', race: { entry_policy: { unpaid_hold_hours: 24 } }, nowMs: NOW })
    expect(r).toEqual({ ok: true, soldByTier: { early: 3, std: 4 } })
  })
  it('pages 1000 at a time and filters on the event, a tier id, and live statuses', async () => {
    const rows = Array.from({ length: 1003 }, () => held('early', 1))
    const d = soldDb(rows)
    const r = await loadSoldByTier(d, { eventId: 'e1', race: {}, nowMs: NOW })
    expect(r.soldByTier.early).toBe(1003)
    const q = d.queries[0]
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'race_event_id', 'e1'], ['not', 'pricing_tier_id', 'is', null], ['order', 'id']]))
    expect(q.ops.some((o) => o[0] === 'in' && o[1] === 'status')).toBe(true)
    expect(d.queries.map((x) => x.ops.find((o) => o[0] === 'range')?.slice(1))).toEqual([[0, 999], [1000, 1999]])
  })
  it('a failed read is load_failed, never zero', async () => {
    expect(await loadSoldByTier(soldDb([], { error: { message: 'timeout' } }), { eventId: 'e1', race: {}, nowMs: NOW })).toMatchObject({ ok: false, error: 'load_failed' })
  })
})

describe('applyTierPricing', () => {
  it('no tiers: the race is unchanged and nothing is read', async () => {
    const d = soldDb([])
    const r = await applyTierPricing(d, { race: { id: 'e1', non_member_fee_cents: 3500, pricing_tiers: null }, headcount: 1, nowMs: NOW })
    expect(r).toEqual({ ok: true, race: { id: 'e1', non_member_fee_cents: 3500, pricing_tiers: null }, tier: null })
    expect(d.queries).toHaveLength(0)
  })
  it('swaps the non-member fee for the tier price and names the tier', async () => {
    const r = await applyTierPricing(soldDb([]), { race: RACE, headcount: 1, nowMs: NOW })
    expect(r.ok).toBe(true)
    expect(r.race.non_member_fee_cents).toBe(2500)
    expect(r.tier.id).toBe('early')
  })
  it('base null stays free after the tiers', async () => {
    const race = { id: 'e1', non_member_fee_cents: null, pricing_tiers: [dec] }
    const r = await applyTierPricing(soldDb([]), { race, headcount: 1, nowMs: Date.parse('2026-12-05T00:00:00Z') })
    expect(r.tier).toBeNull()
    expect(r.race.non_member_fee_cents).toBeNull()
    const before = await applyTierPricing(soldDb([]), { race, headcount: 1, nowMs: NOW })
    expect(before.race.non_member_fee_cents).toBe(3000)
  })
  it('a failed sold read is load_failed: never price blind', async () => {
    expect(await applyTierPricing(soldDb([], { error: { message: 'down' } }), { race: RACE, headcount: 1, nowMs: NOW })).toMatchObject({ ok: false, error: 'load_failed' })
  })
})

describe('publicPricing', () => {
  it('current, next, group and the per-headcount prices the server would charge, with no counts anywhere', () => {
    const p = publicPricing({ race: { ...RACE, allowed_team_sizes: [1, 2, 3, 4] }, nowMs: NOW, soldByTier: { early: 5 } })
    expect(p).toEqual({
      base_cents: 3500,
      current: { id: 'early', name: 'Early bird', price_cents: 2500, ends_at: null, limited: true },
      next: { name: 'Standard', price_cents: 3500, starts_at: null },
      // The early bird is first in order and has room for 3, so it wins over
      // the group tier; the group label is only shown when the group tier is
      // what a group would actually get.
      group: null,
      prices_by_headcount: { 1: 2500, 2: 2500, 3: 2500, 4: 2500 },
    })
    expect(JSON.stringify(p)).not.toMatch(/sold|spots|capacity/)
  })
  it('a group tier that a group would actually get is offered, and the table agrees', () => {
    const p = publicPricing({ race: { ...RACE, allowed_team_sizes: [1, 2, 3, 4] }, nowMs: NOW, soldByTier: { early: 18 } })
    expect(p.group).toEqual({ min_people: 3, price_cents: 2800 })
    expect(p.prices_by_headcount).toEqual({ 1: 2500, 2: 2500, 3: 2800, 4: 2800 })
  })
  it('a group tier behind an uncapped standard tier can never apply, so it is never advertised', () => {
    const p = publicPricing({ race: { ...RACE, allowed_team_sizes: [1, 3], pricing_tiers: [std, group] }, nowMs: NOW, soldByTier: {} })
    expect(p.group).toBeNull()
    expect(p.prices_by_headcount).toEqual({ 1: 3500, 3: 3500 })
  })
  it('"then" skips a tier that has ended or is full', () => {
    const later = publicPricing({ race: { ...RACE, pricing_tiers: [{ ...early, capacity: null }, dec, std] }, nowMs: Date.parse('2026-12-05T00:00:00Z'), soldByTier: {} })
    expect(later.next).toEqual({ name: 'Standard', price_cents: 3500, starts_at: null })
    const full = publicPricing({ race: { ...RACE, pricing_tiers: [{ ...early, capacity: null }, { ...early, id: 'e2', name: 'Second', capacity: 5, price_cents: 3000 }, std] }, nowMs: NOW, soldByTier: { e2: 5 } })
    expect(full.next).toEqual({ name: 'Standard', price_cents: 3500, starts_at: null })
  })
  it('a sold-out early bird is not current; a full group tier is not offered', () => {
    const p = publicPricing({ race: RACE, nowMs: NOW, soldByTier: { early: 20 } })
    expect(p.current?.id).toBe('std')
    expect(p.next).toBeNull()
    const fullGroup = publicPricing({ race: { ...RACE, pricing_tiers: [{ ...group, capacity: 3 }] }, nowMs: NOW, soldByTier: { group: 1 } })
    expect(fullGroup.group).toBeNull()
  })
  it('no tiers → base only, with no table', () => {
    expect(publicPricing({ race: { non_member_fee_cents: 3500, pricing_tiers: null }, nowMs: NOW, soldByTier: {} })).toEqual({ base_cents: 3500, current: null, next: null, group: null, prices_by_headcount: null })
  })
})

describe('labels and the live fee', () => {
  it('tierPriceLabel', () => {
    expect(tierPriceLabel({ base_cents: 3500, current: { name: 'Early bird', price_cents: 2500, ends_at: null, limited: true }, next: { name: 'Standard', price_cents: 3500, starts_at: null }, group: null })).toBe('Early bird €25.00 (limited), then €35.00')
    expect(tierPriceLabel({ base_cents: 3500, current: { name: 'Before December', price_cents: 3000, ends_at: '2026-12-01T00:00:00Z', limited: false }, next: null, group: null }, { zone: 'Europe/Dublin' })).toBe('Before December €30.00 until Tue 1 Dec')
    expect(tierPriceLabel({ base_cents: 3500, current: null, next: null, group: null })).toBe('€35.00 per person')
    expect(tierPriceLabel({ base_cents: null, current: null, next: null, group: null })).toBe('Free')
  })
  it('groupPriceLabel', () => {
    expect(groupPriceLabel({ group: { min_people: 3, price_cents: 2800 } })).toBe('3+ people: €28.00 each')
    expect(groupPriceLabel({ group: null })).toBe('')
  })
  it('effectiveNonMemberFee reads the server table for the headcount, else the current tier, else base', () => {
    const p = { base_cents: 3500, current: { price_cents: 2500 }, next: null, group: { min_people: 3, price_cents: 2800 }, prices_by_headcount: { 1: 2500, 2: 2500, 3: 2800 } }
    expect(effectiveNonMemberFee(p, 1)).toBe(2500)
    expect(effectiveNonMemberFee(p, 3)).toBe(2800)
    expect(effectiveNonMemberFee(p, 5)).toBe(2500) // not in the table: the one-person tier
    expect(effectiveNonMemberFee({ base_cents: 3500, current: null, next: null, group: null, prices_by_headcount: null }, 2)).toBe(3500)
    expect(effectiveNonMemberFee(null, 2)).toBeNull()
  })
  it('the table matches what applyTierPricing charges for the same fixture', async () => {
    const race = { ...RACE, allowed_team_sizes: [1, 2, 3, 4] }
    const sold = { early: 18 }
    const p = publicPricing({ race, nowMs: NOW, soldByTier: sold })
    for (const n of [1, 2, 3, 4]) {
      const rows = Array.from({ length: 18 }, () => held('early', 1))
      const r = await applyTierPricing(soldDb(rows), { race, headcount: n, nowMs: NOW })
      expect(r.race.non_member_fee_cents).toBe(p.prices_by_headcount[n])
    }
  })
  it('canonicalTiers gives one key order with explicit nulls, so a jsonb round trip compares equal', () => {
    const fromForm = [{ id: 'a', name: 'Early', price_cents: 2500, capacity: 20 }]
    const fromDb = [{ id: 'a', name: 'Early', ends_at: null, capacity: 20, starts_at: null, min_people: null, price_cents: 2500 }]
    expect(JSON.stringify(canonicalTiers(fromForm))).toBe(JSON.stringify(canonicalTiers(fromDb)))
    expect(canonicalTiers(null)).toBeNull()
    expect(canonicalTiers([])).toBeNull()
  })
})
