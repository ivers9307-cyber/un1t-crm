// CORPPROMO.1 — grantPromoCredits: a /corp promo's credits through POST
// /credits/grant, ledgered, judged on the body, never re-sent. Never the live
// API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))

import { createUn1tWriter, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { grantPromoCredits, UN1T_PROMO_ORIGIN } from './un1t-online-write-ops.js'
import { LOC, STUDIO, USER, CONTACT, ALL_PERMS, res, ok, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const GRANT = 'POST /credits/grant'
const CREDITS = `GET /credits/ledgers/${USER}/${STUDIO}`
const PROMO = 'hatch-3-free'
const KEY = `promo_grant:${LOC}:${USER}:${PROMO}`

const creditsShow = (balance = 3) => ok({ balance, is_unlimited: false })
const creditsNone = () => ok({ balance: 0, is_unlimited: false })
const granted = () => res(200, { success: true, data: { id: 'batch-1', remaining: 3, expires_at: '2026-11-04T12:00:00.000Z', source: 'admin' } })
const refused = (code, message = 'Refused') => res(400, { success: false, error: { code, message } })

async function setup({ routes = {}, db: dbOpts = {}, perms = ALL_PERMS, writes = true } = {}) {
  const made = makeDb({
    settings: { un1t_online: { writes_enabled: writes } },
    tables: { un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, contact_id: CONTACT, credit_balance: 0 }] },
    ...dbOpts,
  })
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes(perms)], ...routes })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: vi.fn(async () => {}) }))
  return { ...made, fetchImpl, deps: { writerFactory, now: () => new Date() } }
}
const args = (over = {}) => ({ locationId: LOC, un1tUserId: USER, contactId: CONTACT, promoKey: PROMO, amount: 3, expiresInDays: 7, originRef: 'claim-1', ...over })
const promoRows = (store) => (store.un1t_write_events || []).filter((r) => r.op === 'promo_grant')
const ledgerRow = (over) => ({
  id: 'pg-1', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER, op: 'promo_grant', origin: 'corp_promo', target: PROMO, method: null,
  idempotency_key: KEY, created_at: new Date(Date.now() - 10 * 60_000).toISOString(), finished_at: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('grantPromoCredits (CORPPROMO.1)', () => {
  it('sends ONE POST /credits/grant { userId, amount 3, expiresInDays 7 } with its key, then granted with the batch and its expiry', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] } })
    const out = await grantPromoCredits(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'granted', batchId: 'batch-1', expiresAt: '2026-11-04T12:00:00.000Z' })
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === GRANT)
    expect(call.body).toEqual({ userId: USER, amount: 3, expiresInDays: 7 })
    expect(call.headers['idempotency-key']).toBe(KEY)
    expect(promoRows(s.store)).toEqual([expect.objectContaining({ id: out.ledgerId, stage: 'done', origin: UN1T_PROMO_ORIGIN, target: PROMO, un1t_ref: 'batch-1' })])
    expect(s.store.un1t_clients[0].credit_balance).toBe(3)
  })

  it('a done row for the key: granted, nothing sent', async () => {
    const s = await setup({ db: { tables: { un1t_write_events: [ledgerRow({ stage: 'done', un1t_ref: 'batch-0' })] } } })
    expect(await grantPromoCredits(s.db, args(), s.deps)).toEqual({ outcome: 'granted', ledgerId: 'pg-1', batchId: 'batch-0', expiresAt: null })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })

  it('a sent row under the in-flight window: retry, nothing sent', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'sent', created_at: new Date().toISOString() })] } } })
    expect(await grantPromoCredits(s.db, args(), s.deps)).toMatchObject({ outcome: 'retry' })
    expect(s.fetchImpl.count(GRANT)).toBe(0)
  })

  it('an unknown row: credits showing settle it granted; none go to staff; nothing sent either way', async () => {
    const a = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'unknown' })] } } })
    expect(await grantPromoCredits(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', ledgerId: 'pg-1' })
    expect(promoRows(a.store)[0].stage).toBe('done')
    const b = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'unknown' })] } } })
    expect(await grantPromoCredits(b.db, args(), b.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_promo_unverified', ledgerId: 'pg-1' })
    expect(a.fetchImpl.count(GRANT) + b.fetchImpl.count(GRANT)).toBe(0)
  })

  it('credits already on the account: ineligible holds_credits, nothing sent', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsShow(1)] } })
    expect(await grantPromoCredits(s.db, args(), s.deps)).toEqual({ outcome: 'ineligible', reason: 'holds_credits' })
    expect(s.fetchImpl.count(GRANT)).toBe(0)
  })

  it('an unreadable credits read: retry, nothing sent', async () => {
    const s = await setup({ routes: { [CREDITS]: [res(500, {})] } })
    expect(await grantPromoCredits(s.db, args(), s.deps)).toEqual({ outcome: 'retry', code: 'credits_unreadable' })
    expect(s.fetchImpl.count(GRANT)).toBe(0)
  })

  it('an unclear answer is never re-sent: the credits read decides', async () => {
    const a = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [res(502, {})] } })
    expect(await grantPromoCredits(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted' })
    expect(a.fetchImpl.count(GRANT)).toBe(1)
    const b = await setup({ routes: { [CREDITS]: [creditsNone(), creditsNone()], [GRANT]: [res(502, {})] } })
    expect(await grantPromoCredits(b.db, args(), b.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_promo_unverified' })
    expect(b.fetchImpl.count(GRANT)).toBe(1)
  })

  it("un1t.online's refusal goes to staff with its code", async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone()], [GRANT]: [refused('NOPE')] } })
    expect(await grantPromoCredits(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_promo_failed:NOPE' })
    expect(promoRows(s.store)[0].stage).toBe('refused')
  })

  it('writes off, or the token without credits:create: nothing sent', async () => {
    const a = await setup({ writes: false })
    expect((await grantPromoCredits(a.db, args(), a.deps)).outcome).toBe('needs_staff')
    const b = await setup({ perms: ALL_PERMS.filter((p) => p !== 'credits:create') })
    expect((await grantPromoCredits(b.db, args(), b.deps)).outcome).toBe('needs_staff')
    expect(a.fetchImpl.count(GRANT) + b.fetchImpl.count(GRANT)).toBe(0)
  })

  it('amount and expiry must be whole numbers from 1', async () => {
    const s = await setup()
    await expect(grantPromoCredits(s.db, args({ amount: 0 }), s.deps)).rejects.toThrow(TypeError)
    await expect(grantPromoCredits(s.db, args({ expiresInDays: 1.5 }), s.deps)).rejects.toThrow(TypeError)
  })
})
