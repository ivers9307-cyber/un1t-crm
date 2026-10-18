import { describe, it, expect } from 'vitest'
import {
  TIER_DAILY_LIMITS, tierDailyLimit, budgetSnapshot, blastBudgetBlockError,
  effectiveTickHeadroom, countBusinessInitiatedContactsLast24h, getSendBudget,
} from './whatsapp-budget.js'
import { fakeWhatsAppDb, link } from './whatsapp-numbers-fake-db.test-helpers.js'

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
// .from('whatsapp_messages').select(...).in(location_id).eq×2.gt(...).order(...).range(s,e)
// plus the studios-using-the-number lookup (location_whatsapp_numbers,
// WAORGNUMBER.4) that feeds the .in().
// The studio under test is 'loc1' in organisation 'org1'; `world` adds more.
function usageDb(rows, calls = {}, world = {}) {
  calls.filters = []
  const tables = {
    locations: [{ id: 'loc1', organization_id: 'org1' }, ...(world.locations || [])],
  }
  const lookup = (table) => {
    // WAORGNUMBER.1 — "has a number" is the link table; `world.numbers` are
    // whatsapp_numbers rows (each switched on at its home unless `world.links`).
    if (table === 'location_whatsapp_numbers') {
      return fakeWhatsAppDb({
        numbers: world.numbers || [], links: world.links,
        faults: world.fault === table ? { [table]: { message: 'boom' } } : {},
      }).from(table)
    }
    const filters = []
    if (world.fault === table) {
      const failed = { select: () => failed, eq: () => failed, neq: () => failed, in: () => failed,
        maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
        then: (res, rej) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej) }
      return failed
    }
    const b = {
      select: () => b,
      eq(c, v) { filters.push((r) => r[c] === v); return b },
      neq(c, v) { filters.push((r) => r[c] !== v); return b },
      in(c, vals) { filters.push((r) => vals.includes(r[c])); return b },
      limit: () => b,
      maybeSingle: async () => ({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
    }
    return b
  }
  return {
    from: (table) => {
      if (table !== 'whatsapp_messages') return lookup(table)
      calls.table = table
      return {
        select: () => {
          const chain = {
            eq(col, val) { calls.filters.push(['eq', col, val]); return chain },
            in(col, vals) { calls.filters.push(['in', col, vals]); return chain },
            gt(col, val) { calls.filters.push(['gt', col, val]); return chain },
            not(col, op, val) { calls.filters.push(['not', col, op, val]); return chain },
            order() { return chain },
            range: (s, e) => Promise.resolve({
              data: rows.filter((r) => !r.location_id || calls.filters.some(([op, c, v]) => op === 'in' && c === 'location_id' && v.includes(r.location_id)))
                .slice(s, e + 1),
              error: null,
            }),
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
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })).toBe(2)
  })
  it('rows with no linked contact each count once (conservative)', async () => {
    const db = usageDb([
      { id: 1, contact_id: 'a' }, { id: 2, contact_id: null }, { id: 3, contact_id: null },
    ])
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })).toBe(3)
  })
  it('scopes to the location, outbound templates, trailing 24h', async () => {
    const calls = {}
    const db = usageDb([], calls)
    await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })
    expect(calls.table).toBe('whatsapp_messages')
    expect(calls.filters).toEqual(expect.arrayContaining([
      ['in', 'location_id', ['loc1']],
      ['eq', 'direction', 'outbound'],
      ['eq', 'message_type', 'template'],
    ]))
    const gt = calls.filters.find(([op]) => op === 'gt')
    expect(gt[1]).toBe('sent_at')
    const windowMs = Date.now() - new Date(gt[2]).getTime()
    expect(windowMs).toBeGreaterThan(23.9 * 3600 * 1000)
    expect(windowMs).toBeLessThan(24.1 * 3600 * 1000)
  })
  // C106 CHECKINRISKS.1 (d) — a message typed in the studio's linked WhatsApp
  // Business phone app (app_echo / history_sync) never went through the Cloud
  // API: it is not a send we paid for and must not eat the tier budget.
  it('excludes phone-app rows (coexistence echoes and history)', async () => {
    const calls = {}
    const db = usageDb([], calls)
    await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })
    expect(calls.filters).toContainEqual(['not', 'source', 'in', '(app_echo,history_sync)'])
  })
  // WAORGNUMBER.4 (R7) — Meta's limit belongs to the NUMBER, so every studio
  // with it switched on spends from one budget.
  it('counts template sends at every studio using the number', async () => {
    const calls = {}
    const world = {
      locations: [{ id: 'hatch', organization_id: 'org1' }],
      numbers: [{ id: 'n1', location_id: 'loc1', is_active: true }],
      links: [link('loc1', 'n1'), link('hatch', 'n1')],
    }
    const db = usageDb([
      { id: 1, contact_id: 'a', location_id: 'loc1' },
      { id: 2, contact_id: 'b', location_id: 'hatch' },
    ], calls, world)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: 'n1', locationId: 'hatch' })).toBe(2)
    const inFilter = calls.filters.find(([op, c]) => op === 'in' && c === 'location_id')
    expect([...inFilter[2]].sort()).toEqual(['hatch', 'loc1'])
  })
  it('a studio that does not use the number is not counted', async () => {
    const calls = {}
    const world = {
      locations: [{ id: 'third', organization_id: 'org1' }, { id: 'away', organization_id: 'org2' }],
      numbers: [{ id: 'n1', location_id: 'loc1', is_active: true }, { id: 'n2', location_id: 'third', is_active: true },
        { id: 'n3', location_id: 'away', is_active: true }],
      links: [link('loc1', 'n1'), link('third', 'n2'), link('away', 'n3')],
    }
    const db = usageDb([
      { id: 1, contact_id: 'a', location_id: 'loc1' },
      { id: 3, contact_id: 'c', location_id: 'third' },
      { id: 4, contact_id: 'd', location_id: 'away' },
    ], calls, world)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: 'n1', locationId: 'loc1' })).toBe(1)
    expect(calls.filters).toContainEqual(['in', 'location_id', ['loc1']])
  })
  // WAORGNUMBER.6 — the number-less sibling union is gone: a studio with
  // nothing switched on sends nothing, so it has no spend to count.
  it('does not count a number-less same-organisation sibling', async () => {
    const calls = {}
    const world = {
      locations: [{ id: 'hatch', organization_id: 'org1' }],
      numbers: [{ id: 'n1', location_id: 'loc1', is_active: true }],
      links: [link('loc1', 'n1')],
    }
    const db = usageDb([
      { id: 1, contact_id: 'a', location_id: 'loc1' },
      { id: 2, contact_id: 'b', location_id: 'hatch' },
    ], calls, world)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: 'n1', locationId: 'loc1' })).toBe(1)
    expect(calls.filters).toContainEqual(['in', 'location_id', ['loc1']])
  })
  it('always counts the sending studio, even when its link row is gone', async () => {
    const calls = {}
    // The number is switched on only at 'other'; the send was for 'loc1'.
    const world = {
      locations: [{ id: 'other', organization_id: 'org1' }],
      numbers: [{ id: 'n1', location_id: 'other', is_active: true }, { id: 'n9', location_id: 'loc1', is_active: true }],
      links: [link('other', 'n1'), link('loc1', 'n9')],
    }
    const db = usageDb([
      { id: 1, contact_id: 'a', location_id: 'loc1' },
      { id: 2, contact_id: 'b', location_id: 'other' },
    ], calls, world)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: 'n1', locationId: 'loc1' })).toBe(2)
    const inFilter = calls.filters.find(([op, c]) => op === 'in' && c === 'location_id')
    expect([...inFilter[2]].sort()).toEqual(['loc1', 'other'])
  })
  it('no number id counts the studio alone', async () => {
    const calls = {}
    const db = usageDb([{ id: 1, contact_id: 'a', location_id: 'loc1' }], calls)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })).toBe(1)
    expect(calls.filters).toContainEqual(['in', 'location_id', ['loc1']])
  })
  it('failed link read throws (never counts a smaller set)', async () => {
    for (const table of ['location_whatsapp_numbers']) {
      const db = usageDb([], {}, { fault: table, locations: [{ id: 'hatch', organization_id: 'org1' }] })
      await expect(countBusinessInitiatedContactsLast24h(db, { numberId: 'n1', locationId: 'loc1' })).rejects.toThrow(/boom/)
    }
  })
  it('paginates past the 1,000-row PostgREST cap', async () => {
    const rows = []
    for (let i = 0; i < 1000; i++) rows.push({ id: i, contact_id: `c${i}` })
    for (let i = 0; i < 500; i++) rows.push({ id: 1000 + i, contact_id: `c${i}` }) // dupes of page 1
    rows.push({ id: 9999, contact_id: 'extra' })
    const db = usageDb(rows)
    expect(await countBusinessInitiatedContactsLast24h(db, { numberId: null, locationId: 'loc1' })).toBe(1001)
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
  it('budgets the number across every studio using it', async () => {
    const world = {
      locations: [{ id: 'hatch', organization_id: 'org1' }],
      numbers: [{ id: 'n1', location_id: 'loc1', is_active: true }],
      links: [link('loc1', 'n1'), link('hatch', 'n1')],
    }
    const db = usageDb([
      { id: 1, contact_id: 'a', location_id: 'loc1' },
      { id: 2, contact_id: 'b', location_id: 'hatch' },
    ], {}, world)
    expect(await getSendBudget(db, { numberId: 'n1', locationId: 'hatch', tier: 'TIER_50' }))
      .toEqual({ tier: 'TIER_50', limit: 50, used: 2, remaining: 48 })
  })
  it('returns the snapshot for a gated tier', async () => {
    const db = usageDb([{ id: 1, contact_id: 'a' }, { id: 2, contact_id: 'b' }])
    expect(await getSendBudget(db, { numberId: null, locationId: 'loc1', tier: 'TIER_250' }))
      .toEqual({ tier: 'TIER_250', limit: 250, used: 2, remaining: 248 })
  })
})
