// GLOFOX-CATALOG — tests for the catalog parser + resolver, built from
// the REAL /2.0/memberships response shape (Stillorgan, 8 plans).
import { describe, it, expect } from 'vitest'
import { stripPlanPrefix, parseMembershipCatalog, matchCatalogToPlan } from './glofox-catalog'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// Trimmed but faithful to the live payload.
const REAL_BODY = {
  object: 'list', total_count: 3,
  data: [
    {
      _id: '659442d20e66eb19f0074532',
      name: '2) The Monthly Membership (€99 FIRST MONTH)',
      description: '€99 first months membership\n€209 per month thereafter - requires a 30-day notice to cancel with a 3 month commitment.',
      active: true, type: 'membership',
      plans: [{ code: 1704215234363, price: 99, type: 'time', name: 'Month to Month Membership' }],
    },
    {
      _id: '659443a6a0b7d1b6a40687dc',
      name: '3) The 3 Month Membership - €100 Discount',
      description: '€199 per month billed every 3 Months\n\nRequires 30-day notice to cancel',
      active: true, type: 'membership',
      plans: [{ code: 1704215281195, price: 497, type: 'time', name: '3 Month Membership' }],
    },
    {
      _id: '620bdab4df0f8054814cd7be',
      name: '1) The UN1T Trial',
      description: '3  Classes - 7 Day Expiry',
      active: true, type: 'membership',
      plans: [{ code: 1644944026897, price: 0, type: 'num_classes', name: 'The UN1T Trial' }],
    },
  ],
}

describe('stripPlanPrefix', () => {
  it('drops the "N) " sort-order prefix', () => {
    expect(stripPlanPrefix('3) The 3 Month Membership - €100 Discount')).toBe('The 3 Month Membership - €100 Discount')
    expect(stripPlanPrefix('Class Packs')).toBe('Class Packs')
    expect(stripPlanPrefix(null)).toBeNull()
  })
})

describe('parseMembershipCatalog', () => {
  const rows = parseMembershipCatalog(REAL_BODY, LOC)

  it('parses one row per membership with the description captured', () => {
    expect(rows).toHaveLength(3)
    const monthly = rows.find(r => r.glofox_membership_id === '659442d20e66eb19f0074532')
    expect(monthly.description).toContain('thereafter')
    expect(monthly.description).toContain('3 month commitment')
    expect(monthly.name_clean).toBe('The Monthly Membership (€99 FIRST MONTH)')
    expect(monthly.plan_names).toEqual(['Month to Month Membership'])
    expect(monthly.price_cents).toBe(9900)
    expect(monthly.location_id).toBe(LOC)
    expect(monthly.active).toBe(true)
  })

  it('handles a bare array body too', () => {
    expect(parseMembershipCatalog(REAL_BODY.data, LOC)).toHaveLength(3)
  })

  it('skips entries without an id and tolerates junk', () => {
    expect(parseMembershipCatalog({ data: [{ name: 'no id' }, null, 5] }, LOC)).toEqual([])
    expect(parseMembershipCatalog(null, LOC)).toEqual([])
  })

  it('nulls description when absent/blank', () => {
    const r = parseMembershipCatalog({ data: [{ _id: 'x', name: 'X', description: '  ' }] }, LOC)
    expect(r[0].description).toBeNull()
  })
})

describe('matchCatalogToPlan', () => {
  const catalog = parseMembershipCatalog(REAL_BODY, LOC)

  it('matches by full catalog name (planFull)', () => {
    const row = matchCatalogToPlan(catalog, { planFull: 'The 3 Month Membership - €100 Discount' })
    expect(row?.glofox_membership_id).toBe('659443a6a0b7d1b6a40687dc')
    expect(row.description).toContain('€199 per month')
  })

  it('matches by plans[].name (the clean plan)', () => {
    const row = matchCatalogToPlan(catalog, { plan: '3 Month Membership' })
    expect(row?.glofox_membership_id).toBe('659443a6a0b7d1b6a40687dc')
  })

  it('is case-insensitive', () => {
    expect(matchCatalogToPlan(catalog, { plan: 'the un1t trial' })?.name_clean).toBe('The UN1T Trial')
  })

  it('returns null for an archived/unknown plan (e.g. old Black Friday)', () => {
    expect(matchCatalogToPlan(catalog, { plan: 'Black Friday Unlimited Monthly Membership (Plan 1)' })).toBeNull()
  })

  it('returns null on empty inputs', () => {
    expect(matchCatalogToPlan([], { plan: 'x' })).toBeNull()
    expect(matchCatalogToPlan(catalog, {})).toBeNull()
  })
})

// ── GLOFOXPRIVATE.1 (mig 796) — the catalogue learns the memberships the list hides ──
import { vi } from 'vitest'
import { learnMembershipById, learnedPrivateMemberships, LEARN_FRESH_MS } from './glofox-catalog'

// The REAL by-id body for a private membership (Stillorgan, 2026-10-31).
const ELITES = {
  _id: '68b17bbd4e9e83430f0ddcdc', branch_id: 'b1', active: true, name: '1) The Elites Trial',
  description: 'The Elites program is a coach led small group strength class.', buy_just_once: true, private: true, trial: true,
  plans: [{ code: 1756461990251, price: 0, type: 'num_classes', name: 'The Elites Trial' }], type: 'membership',
}

// A tiny chainable supabase mock: one table, select → maybeSingle / order, upsert recorded.
function mockDb({ existing = null, selectError = null, rows = [], listError = null, upsertError = null } = {}) {
  const calls = { upserts: [] }
  const chain = {
    select: vi.fn(() => chain), eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: existing, error: selectError })),
    order: vi.fn(async () => ({ data: rows, error: listError })),
  }
  const db = {
    from: vi.fn(() => ({
      ...chain,
      upsert: vi.fn(async (row, opts) => { calls.upserts.push({ row, opts }); return { error: upsertError } }),
    })),
  }
  return { db, calls, chain }
}

describe('parseMembershipCatalog — private flag', () => {
  it('keeps the by-id body\'s private flag and nulls it when the body does not say', () => {
    const [row] = parseMembershipCatalog([ELITES], LOC)
    expect(row.private).toBe(true)
    expect(row.plan_names).toEqual(['The Elites Trial'])
    expect(parseMembershipCatalog(REAL_BODY, LOC)[0].private).toBeNull()
  })
})

describe('learnMembershipById', () => {
  const creds = { branchId: 'b1', apiKey: 'k', apiToken: 't' }

  it('reads an unknown membership by id and writes it as member_detail with its private flag', async () => {
    const { db, calls } = mockDb({ existing: null })
    const cache = new Map([[ELITES._id, ELITES]]) // the run already holds the object: no Glofox call
    const r = await learnMembershipById(db, LOC, creds, ELITES._id, cache)
    expect(r).toEqual({ ok: true, action: 'learned', private: true })
    expect(calls.upserts).toHaveLength(1)
    const { row, opts } = calls.upserts[0]
    expect(opts).toEqual({ onConflict: 'glofox_membership_id' })
    expect(row).toMatchObject({ glofox_membership_id: ELITES._id, location_id: LOC, private: true, discovered_via: 'member_detail', name: '1) The Elites Trial' })
    expect(typeof row.synced_at).toBe('string')
    expect(cache.get(`learned:${ELITES._id}`)).toBe(true)
  })

  it('does not ask Glofox again for a row refreshed this week', async () => {
    const { db, calls } = mockDb({ existing: { glofox_membership_id: ELITES._id, private: true, synced_at: new Date(Date.now() - LEARN_FRESH_MS / 2).toISOString() } })
    const cache = new Map()
    const r = await learnMembershipById(db, LOC, creds, ELITES._id, cache)
    expect(r).toEqual({ ok: true, action: 'fresh', private: true })
    expect(calls.upserts).toHaveLength(0)
    expect(cache.get(`learned:${ELITES._id}`)).toBe(true)
  })

  it('re-reads a stale row, and a pre-796 row whose private flag is unknown', async () => {
    const stale = { glofox_membership_id: ELITES._id, private: true, synced_at: new Date(Date.now() - LEARN_FRESH_MS - 1000).toISOString() }
    const a = mockDb({ existing: stale })
    expect((await learnMembershipById(a.db, LOC, creds, ELITES._id, new Map([[ELITES._id, ELITES]]))).action).toBe('learned')
    const unknown = { glofox_membership_id: ELITES._id, private: null, synced_at: new Date().toISOString() }
    const b = mockDb({ existing: unknown })
    expect((await learnMembershipById(b.db, LOC, creds, ELITES._id, new Map([[ELITES._id, ELITES]]))).action).toBe('learned')
  })

  it('settles an id once per run through the cache and skips bad input', async () => {
    const { db, chain } = mockDb()
    const cache = new Map([[`learned:${ELITES._id}`, true]])
    expect(await learnMembershipById(db, LOC, creds, ELITES._id, cache)).toEqual({ ok: true, action: 'cached' })
    expect(chain.maybeSingle).not.toHaveBeenCalled()
    expect(await learnMembershipById(db, LOC, creds, '', cache)).toEqual({ ok: false, action: 'skipped' })
    expect(await learnMembershipById(db, LOC, null, ELITES._id, cache)).toEqual({ ok: false, action: 'skipped' })
  })

  it('a 404 is an answer (cached, nothing written); a failed read or write is reported, never thrown', async () => {
    const notFound = mockDb()
    const cache = new Map([[ELITES._id, null]]) // fetchMembershipResult's cached "no such membership"
    expect(await learnMembershipById(notFound.db, LOC, creds, ELITES._id, cache)).toEqual({ ok: true, action: 'not_found' })
    expect(notFound.calls.upserts).toHaveLength(0)
    const readFail = mockDb({ selectError: { message: 'boom' } })
    expect(await learnMembershipById(readFail.db, LOC, creds, ELITES._id, new Map())).toEqual({ ok: false, action: 'read_failed', error: 'boom' })
    const writeFail = mockDb({ upsertError: { message: 'nope' } })
    expect(await learnMembershipById(writeFail.db, LOC, creds, ELITES._id, new Map([[ELITES._id, ELITES]]))).toEqual({ ok: false, action: 'write_failed', error: 'nope' })
    const throwing = { from: () => { throw new Error('db down') } }
    expect(await learnMembershipById(throwing, LOC, creds, ELITES._id, new Map())).toEqual({ ok: false, action: 'threw', error: 'db down' })
  })
})

describe('learnedPrivateMemberships', () => {
  const stored = { glofox_membership_id: ELITES._id, name: ELITES.name, active: true, private: true, plans: ELITES.plans }

  it('returns learned private rows in the live-list shape, minus ids the live list returned', async () => {
    const { db, chain } = mockDb({ rows: [stored, { ...stored, glofox_membership_id: 'now-public' }] })
    const { rows, error } = await learnedPrivateMemberships(db, LOC, new Set(['now-public']))
    expect(error).toBeNull()
    expect(rows).toEqual([{
      _id: ELITES._id, name: '1) The Elites Trial', active: true, private: true,
      plans: [{ code: '1756461990251', type: 'num_classes', price: 0, name: 'The Elites Trial' }],
    }])
    expect(chain.eq).toHaveBeenCalledWith('location_id', LOC)
    expect(chain.eq).toHaveBeenCalledWith('private', true)
  })

  it('a failed read answers no rows and the error, never throws', async () => {
    const { db } = mockDb({ listError: { message: 'down' } })
    expect(await learnedPrivateMemberships(db, LOC)).toEqual({ rows: [], error: 'down' })
    expect(await learnedPrivateMemberships({}, LOC)).toMatchObject({ rows: [] })
    expect((await learnedPrivateMemberships({}, LOC)).error).toBeTruthy()
  })
})
