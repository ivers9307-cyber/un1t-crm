import { describe, it, expect } from 'vitest'
import {
  TIER_DAILY_LIMITS, tierDailyLimit, budgetSnapshot, blastBudgetBlockError,
  effectiveTickHeadroom, countBusinessInitiatedContactsLast24h, getSendBudget,
} from './whatsapp-budget.js'

describe('tierDailyLimit', () => {
  it('maps every gated Meta tier to its daily unique-contact limit', () => {
    expect(tierDailyLimit('TIER_50')).toBe(50)
    expect(tierDailyLimit('TIER_250')).toBe(250)
    expect(tierDailyLimit('TIER_1K')).toBe(1000)
    expect(tierDailyLimit('TIER_10K')).toBe(10000)
    expect(tierDailyLimit('TIER_100K')).toBe(100000)
  })
  it('UNLIMITED / null / unknown tiers are ungated (null)', () => {
    expect(tierDailyLimit('UNLIMITED')).toBeNull()
    expect(tierDailyLimit(null)).toBeNull()
    expect(tierDailyLimit(undefined)).toBeNull()
    expect(tierDailyLimit('TIER_9000')).toBeNull()
  })
  it('limits stay consistent with the tier map', () => {
    expect(Object.keys(TIER_DAILY_LIMITS).sort()).toEqual(
      ['TIER_100K', 'TIER_10K', 'TIER_1K', 'TIER_250', 'TIER_50'].sort()
    )
  })
})

describe('budgetSnapshot', () => {
  it('computes remaining headroom for a gated tier', () => {
    expect(budgetSnapshot({ tier: 'TIER_1K', usedContacts: 400 }))
      .toEqual({ tier: 'TIER_1K', limit: 1000, used: 400, remaining: 600 })
  })
  it('clamps remaining at zero when over-used', () => {
    expect(budgetSnapshot({ tier: 'TIER_250', usedContacts: 300 }).remaining).toBe(0)
  })
  it('treats missing usage as zero', () => {
    expect(budgetSnapshot({ tier: 'TIER_50' }).remaining).toBe(50)
  })
  it('ungated tiers produce no snapshot (no gate)', () => {
    expect(budgetSnapshot({ tier: 'UNLIMITED', usedContacts: 5 })).toBeNull()
    expect(budgetSnapshot({ tier: null, usedContacts: 5 })).toBeNull()
  })
})

describe('blastBudgetBlockError', () => {
  const budget = { tier: 'TIER_1K', limit: 1000, used: 900, remaining: 100 }
  it('refuses a blast whose pending audience exceeds remaining headroom', () => {
    const msg = blastBudgetBlockError(budget, 250)
    expect(msg).toContain('250')
    expect(msg).toContain('100')
    expect(msg).toContain('1,000 / day')   // tierLabel of TIER_1K
    expect(msg).toMatch(/24/)              // says when capacity frees up
    expect(msg).toMatch(/cannot be forced|hard-reject/i)
  })
  it('passes at or under the remaining headroom', () => {
    expect(blastBudgetBlockError(budget, 100)).toBeNull()
    expect(blastBudgetBlockError(budget, 1)).toBeNull()
    expect(blastBudgetBlockError(budget, 0)).toBeNull()
  })
  it('no budget (ungated tier) never blocks', () => {
    expect(blastBudgetBlockError(null, 50_000)).toBeNull()
  })
})

describe('effectiveTickHeadroom', () => {
  it('caps the per-broadcast headroom to the global tier remaining', () => {
    expect(effectiveTickHeadroom(100, { remaining: 30 })).toBe(30)
    expect(effectiveTickHeadroom(20, { remaining: 30 })).toBe(20)
    expect(effectiveTickHeadroom(100, { remaining: 0 })).toBe(0)
  })
  it('no budget (ungated tier) leaves the cap untouched', () => {
    expect(effectiveTickHeadroom(100, null)).toBe(100)
  })
})

// Fake db mimicking the paginated usage query chain:
// .from('whatsapp_messages').select(...).eq×3.gt(...).order(...).range(s,e)
function usageDb(rows, calls = {}) {
  calls.filters = []
  return {
    from: (table) => {
      calls.table = table
      return {
        select: () => {
          const chain = {
            eq(col, val) { calls.filters.push(['eq', col, val]); return chain },
            gt(col, val) { calls.filters.push(['gt', col, val]); return chain },
            order() { return chain },
            range: (s, e) => Promise.resolve({ data: rows.slice(s, e + 1), error: null }),
          }
          return chain
        },
      }
    },
  }
}

describe('countBusinessInitiatedContactsLast24h', () => {
  it('counts DISTINCT contacts (a contact hit by two templates is one conversation)', async () => {
    const db = usageDb([
      { id: 1, contact_id: 'a' }, { id: 2, contact_id: 'a' }, { id: 3, contact_id: 'b' },
    ])
    expect(await countBusinessInitiatedContactsLast24h(db, 'loc1')).toBe(2)
  })
  it('rows with no linked contact each count once (conservative)', async () => {
    const db = usageDb([
      { id: 1, contact_id: 'a' }, { id: 2, contact_id: null }, { id: 3, contact_id: null },
    ])
    expect(await countBusinessInitiatedContactsLast24h(db, 'loc1')).toBe(3)
  })
  it('scopes to the location, outbound templates, trailing 24h', async () => {
    const calls = {}
    const db = usageDb([], calls)
    await countBusinessInitiatedContactsLast24h(db, 'loc1')
    expect(calls.table).toBe('whatsapp_messages')
    expect(calls.filters).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'loc1'],
      ['eq', 'direction', 'outbound'],
      ['eq', 'message_type', 'template'],
    ]))
    const gt = calls.filters.find(([op]) => op === 'gt')
    expect(gt[1]).toBe('sent_at')
    const windowMs = Date.now() - new Date(gt[2]).getTime()
    expect(windowMs).toBeGreaterThan(23.9 * 3600 * 1000)
    expect(windowMs).toBeLessThan(24.1 * 3600 * 1000)
  })
  it('paginates past the 1,000-row PostgREST cap', async () => {
    const rows = []
    for (let i = 0; i < 1000; i++) rows.push({ id: i, contact_id: `c${i}` })
    for (let i = 0; i < 500; i++) rows.push({ id: 1000 + i, contact_id: `c${i}` }) // dupes of page 1
    rows.push({ id: 9999, contact_id: 'extra' })
    const db = usageDb(rows)
    expect(await countBusinessInitiatedContactsLast24h(db, 'loc1')).toBe(1001)
  })
})

describe('getSendBudget', () => {
  it('skips the usage query entirely for an ungated tier', async () => {
    const db = { from: () => { throw new Error('must not query for UNLIMITED') } }
    expect(await getSendBudget(db, { locationId: 'loc1', tier: 'UNLIMITED' })).toBeNull()
    expect(await getSendBudget(db, { locationId: 'loc1', tier: null })).toBeNull()
  })
  it('no location context → no gate (env-fallback configs)', async () => {
    const db = { from: () => { throw new Error('must not query without a location') } }
    expect(await getSendBudget(db, { locationId: null, tier: 'TIER_250' })).toBeNull()
  })
  it('returns the snapshot for a gated tier', async () => {
    const db = usageDb([{ id: 1, contact_id: 'a' }, { id: 2, contact_id: 'b' }])
    expect(await getSendBudget(db, { locationId: 'loc1', tier: 'TIER_250' }))
      .toEqual({ tier: 'TIER_250', limit: 250, used: 2, remaining: 248 })
  })
})
