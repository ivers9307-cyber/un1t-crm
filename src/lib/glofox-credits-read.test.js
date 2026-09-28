// CREDITSREAD.1 — a failed Glofox credits (or membership) read used to look
// like "no packs": previewMemberSync wrote NULL over the stored balance and
// re-labelled a stored credit_member as member. A read that failed now leaves
// both as they were, says so on the result (credits_unread) and logs one line.
// A healthy read is unchanged, including a genuine NULL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./log.js', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from './log.js'
import { buildCreditMemberContext, previewMemberSync, applyMemberSync } from './glofox-sync.js'

const LOC = 'loc-1'
const GID = '0000000000000000000000a1'
const PACKS_ID = '0000000000000000000000f1'
const PACKS = { _id: PACKS_ID, trial: false, plans: [{ type: 'num_classes' }] }
const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }

// A paying member with an active pack: lead_status MEMBER + active.
const member = { _id: GID, email: 'credits-read@example.com', first_name: 'Cee', last_name: 'Ar', active: true, lead_status: 'MEMBER' }
const pack = (available) => ({ active: true, membership_id: PACKS_ID, available })
const packsCache = () => new Map([[PACKS_ID, PACKS]])
const stored = (over = {}) => ({
  id: 'c-1', email: 'credits-read@example.com', first_name: 'Cee', last_name: 'Ar', glofox_member_id: GID,
  glofox_membership_status: 'credit_member', trial_credits_remaining: 7, ...over,
})

// Chainable db: contact lookups answer `existing`; updates are captured.
function makeDb(existing) {
  const updates = []
  const from = (table) => {
    const st = { table, op: 'select' }
    const rows = () => (table === 'contacts' && st.op === 'select' && existing ? [existing] : [])
    const c = {}
    for (const m of ['select', 'eq', 'in', 'not', 'is', 'or', 'order', 'range', 'filter']) c[m] = () => c
    c.limit = () => Promise.resolve({ data: rows(), error: null })
    c.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    c.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    c.update = (payload) => { st.op = 'update'; updates.push({ table, payload }); return c }
    c.insert = () => { st.op = 'insert'; return c }
    c.upsert = () => { st.op = 'upsert'; return c }
    c.then = (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej)
    return c
  }
  return { from, updates }
}

beforeEach(() => vi.clearAllMocks())

describe('buildCreditMemberContext', () => {
  const res = (status, body = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
    json: async () => body,
  })
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  it('credits read failed: creditsFailed, and no membership is fetched', async () => {
    fetch.mockResolvedValue(res(500))
    const ctx = await buildCreditMemberContext(creds, member, new Map())
    expect(ctx).toMatchObject({ credits: [], creditsFailed: true, membershipsFailed: true })
    expect(fetch.mock.calls.every(([url]) => String(url).includes('/2.0/credits'))).toBe(true)
  })

  it('credits read, membership read failed: membershipsFailed only, and the failure is not cached', async () => {
    fetch.mockImplementation(async (url) => (String(url).includes('/2.0/credits')
      ? res(200, { data: [pack(3)] })
      : res(500)))
    const cache = new Map()
    const ctx = await buildCreditMemberContext(creds, member, cache)
    expect(ctx.creditsFailed).toBe(false)
    expect(ctx.membershipsFailed).toBe(true)
    expect(ctx.credits).toEqual([pack(3)])
    expect(cache.has(PACKS_ID)).toBe(false)
  })

  it('both read: no flags', async () => {
    fetch.mockImplementation(async (url) => (String(url).includes('/2.0/credits')
      ? res(200, { data: [pack(3)] })
      : res(200, PACKS)))
    const ctx = await buildCreditMemberContext(creds, member, new Map())
    expect(ctx).toMatchObject({ creditsFailed: false, membershipsFailed: false })
    expect(ctx.memberships.get(PACKS_ID)).toEqual(PACKS)
  })
})

describe('previewMemberSync — an unread credit context', () => {
  it('credits read failed: the stored balance and credit_member label are kept, and it says so', async () => {
    const out = await previewMemberSync(makeDb(stored()), LOC, member, {
      ctx: { credits: [], memberships: packsCache(), creditsFailed: true, membershipsFailed: true },
    })
    expect(out.action).toBe('update')
    expect(out.changes).not.toHaveProperty('trial_credits_remaining')
    expect(out.changes).not.toHaveProperty('glofox_membership_status')
    expect(out.mapped.glofox_membership_status).toBe('credit_member')
    expect(out.credits_unread).toBe(true)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('glofox-sync', expect.stringContaining('credits read failed'), {
      locationId: LOC, contactId: 'c-1', unread: 'credits',
    })
    // the log line carries no Glofox id and no email
    expect(JSON.stringify(logWarn.mock.calls[0])).not.toContain(GID)
    expect(JSON.stringify(logWarn.mock.calls[0])).not.toContain('@')
  })

  it('membership read failed: the balance IS written (credits were read), the label is kept', async () => {
    const out = await previewMemberSync(makeDb(stored()), LOC, member, {
      ctx: { credits: [pack(8)], memberships: new Map(), creditsFailed: false, membershipsFailed: true },
    })
    expect(out.changes.trial_credits_remaining).toEqual({ from: 7, to: 8 })
    expect(out.changes).not.toHaveProperty('glofox_membership_status')
    expect(out.mapped.glofox_membership_status).toBe('credit_member')
    expect(out.credits_unread).toBe(true)
    expect(logWarn.mock.calls[0][2]).toEqual({ locationId: LOC, contactId: 'c-1', unread: 'memberships' })
  })

  it('a stored member stays member (the hold only ever keeps credit_member)', async () => {
    const out = await previewMemberSync(makeDb(stored({ glofox_membership_status: 'member', trial_credits_remaining: null })), LOC, member, {
      ctx: { credits: [], memberships: new Map(), creditsFailed: true, membershipsFailed: true },
    })
    expect(out.mapped.glofox_membership_status).toBe('member')
    expect(out.changes).not.toHaveProperty('glofox_membership_status')
    expect(out.changes).not.toHaveProperty('trial_credits_remaining')
  })

  it('Glofox saying something other than member still wins (credit detection never chooses it)', async () => {
    const trial = { ...member, lead_status: 'TRIAL' }
    const out = await previewMemberSync(makeDb(stored()), LOC, trial, {
      ctx: { credits: [], memberships: new Map(), creditsFailed: true, membershipsFailed: true },
    })
    expect(out.changes.glofox_membership_status).toEqual({ from: 'credit_member', to: 'trial' })
    expect(out.changes).not.toHaveProperty('trial_credits_remaining')
  })
})

describe('a membership 404 is an ANSWER, not a failed read', () => {
  const res = (status, body = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.001' : null) },
    json: async () => body,
  })
  const membershipCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes('/2.0/memberships/')).length
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  it('404 behind an active pack: read (no credits_unread), normal detection applies, cached for the run', async () => {
    fetch.mockImplementation(async (url) => (String(url).includes('/2.0/credits')
      ? res(200, { data: [pack(6)] })
      : res(404, { message: 'not found' })))
    const cache = new Map()
    const out = await previewMemberSync(makeDb(stored()), LOC, member, { creds, membershipCache: cache })
    expect(out).not.toHaveProperty('credits_unread')
    // Not a Class Pack membership (it does not exist), so the stored label is NOT held.
    expect(out.changes.glofox_membership_status).toEqual({ from: 'credit_member', to: 'member' })
    expect(out.changes.trial_credits_remaining).toEqual({ from: 7, to: 6 })
    expect(cache.has(PACKS_ID)).toBe(true)
    expect(cache.get(PACKS_ID)).toBeNull()
    // A second member in the same run does not ask again.
    await previewMemberSync(makeDb(stored()), LOC, member, { creds, membershipCache: cache })
    expect(membershipCalls()).toBe(1)
  })

  it('500 on the membership read: still unread, the label is held, nothing cached', async () => {
    fetch.mockImplementation(async (url) => (String(url).includes('/2.0/credits')
      ? res(200, { data: [pack(6)] })
      : res(500)))
    const cache = new Map()
    const out = await previewMemberSync(makeDb(stored()), LOC, member, { creds, membershipCache: cache })
    expect(out.credits_unread).toBe(true)
    expect(out.changes).not.toHaveProperty('glofox_membership_status')
    expect(cache.has(PACKS_ID)).toBe(false)
  })

  it('429 on the membership read is a failure too (uncached)', async () => {
    fetch.mockImplementation(async (url) => (String(url).includes('/2.0/credits')
      ? res(200, { data: [pack(6)] })
      : res(429)))
    const cache = new Map()
    const ctx = await buildCreditMemberContext(creds, member, cache)
    expect(ctx.membershipsFailed).toBe(true)
    expect(cache.has(PACKS_ID)).toBe(false)
  })
})

describe('previewMemberSync — a healthy read is unchanged', () => {
  it('Glofox genuinely has no active pack: NULL is written and the label follows (no flag, no log)', async () => {
    const out = await previewMemberSync(makeDb(stored()), LOC, member, {
      ctx: { credits: [], memberships: packsCache(), creditsFailed: false, membershipsFailed: false },
    })
    expect(out.changes.trial_credits_remaining).toEqual({ from: 7, to: null })
    expect(out.changes.glofox_membership_status).toEqual({ from: 'credit_member', to: 'member' })
    expect(out).not.toHaveProperty('credits_unread')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('an active Class Pack: credit_member with its live balance', async () => {
    const out = await previewMemberSync(makeDb(stored({ glofox_membership_status: 'member', trial_credits_remaining: null })), LOC, member, {
      ctx: { credits: [pack(5)], memberships: packsCache() },
    })
    expect(out.changes.glofox_membership_status).toEqual({ from: 'member', to: 'credit_member' })
    expect(out.changes.trial_credits_remaining).toEqual({ from: null, to: 5 })
    expect(out).not.toHaveProperty('credits_unread')
  })
})

describe('applyMemberSync — what reaches the database', () => {
  it('an unread credit context writes neither column; the rest of the sync still runs', async () => {
    const db = makeDb(stored({ phone: null }))
    const out = await applyMemberSync(db, LOC, { ...member, phone: '0871234567' }, {
      ctx: { credits: [], memberships: new Map(), creditsFailed: true, membershipsFailed: true },
      skipReclassify: true,
    })
    expect(out.action).toBe('update')
    expect(out.credits_unread).toBe(true)
    const contactWrite = db.updates.find((u) => u.table === 'contacts')
    expect(contactWrite.payload).not.toHaveProperty('trial_credits_remaining')
    expect(contactWrite.payload).not.toHaveProperty('glofox_membership_status')
    expect(contactWrite.payload).toHaveProperty('phone')              // the sync is not stopped
    expect(contactWrite.payload).toHaveProperty('glofox_synced_at')
  })
})
