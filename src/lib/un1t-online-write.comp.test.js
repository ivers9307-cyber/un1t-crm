// UN1TCOMP.1 — grantCompCredits: staff add complimentary class credits to a
// member's un1t.online account (Richard's decision 28 Oct 2026). One POST
// /credits/grant { userId, amount, expiresInDays }, op comp_credits, never
// re-sent; after a 5xx or a timeout the credits ledger read decides whether it
// landed. Never the live API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))

import { createUn1tWriter, UN1T_WRITE_CODES, UN1T_OP_POLICY, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { grantCompCredits, findLandedCompGrant } from './un1t-online-write-ops.js'
import { judgeUn1tWrite, REQUIRED_PERMISSIONS, UN1T_WRITE_OPS } from './un1t-online-write-judge.js'
import { ledgerKey } from './un1t-online-write-ledger.js'
import { LOC, STUDIO, USER, CONTACT, ALL_PERMS, res, ok, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const C = UN1T_WRITE_CODES
const GRANT = 'POST /credits/grant'
const CREDITS = `GET /credits/ledgers/${USER}/${STUDIO}`
const REQ = '99999999-9999-4999-8999-999999999999'
const DAY = 86_400_000

const expiresIn = (days, fromMs = Date.now()) => new Date(fromMs + days * DAY).toISOString()
const grantedBody = (over = {}) => ({
  id: 'batch-9', credit_ledger_id: 'cl-9', transaction_id: null, product_id: null, source: 'admin',
  original_amount: 2, remaining: 2, expires_at: expiresIn(8), created_at: new Date().toISOString(), ...over,
})
const granted = (over) => res(201, { success: true, data: grantedBody(over) })
const ledgerWith = (batches, extra = {}) => ok({ balance: 5, is_unlimited: false, batches, ...extra })

async function setup({ routes = {}, db: dbOpts = {}, perms = ALL_PERMS } = {}) {
  const made = makeDb({
    tables: { un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, contact_id: CONTACT, credit_balance: 3, credit_unlimited: false }] },
    ...dbOpts,
  })
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes(perms)], ...routes })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: vi.fn(async () => {}) }))
  return { ...made, fetchImpl, deps: { writerFactory, now: () => new Date() } }
}
const args = (over = {}) => ({
  locationId: LOC, contactId: CONTACT, un1tUserId: USER, amount: 2, expiresInDays: 8, useBy: '2026-11-05',
  reason: 'goodwill', note: 'Sorry about Tuesday', requestId: REQ, origin: 'staff', actor: { id: 'staff-1' }, ...over,
})
const compRows = (store) => store.un1t_write_events.filter((r) => r.op === 'comp_credits')

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('the op: permissions, policy, judge', () => {
  it('comp_credits is a write op of its own, never re-sent, needing credits:create and credits:read', () => {
    expect(UN1T_WRITE_OPS).toContain('comp_credits')
    expect(UN1T_OP_POLICY.comp_credits).toBe('never')
    expect(UN1T_OP_POLICY.trial_regrant).toBe('never')
    expect(REQUIRED_PERMISSIONS.comp_credits).toEqual(['credits:create', 'credits:read'])
  })

  it('done only on success:true with the amount we asked for; a different amount is unknown; a refusal keeps its words', () => {
    const want = { amount: 2 }
    expect(judgeUn1tWrite('comp_credits', { status: 201, body: { success: true, data: grantedBody() }, expect: want })).toMatchObject({ verdict: 'done', id: 'batch-9' })
    expect(judgeUn1tWrite('comp_credits', { status: 201, body: { success: true, data: grantedBody({ original_amount: 5 }) }, expect: want }))
      .toMatchObject({ verdict: 'unknown', code: 'response_mismatch' })
    expect(judgeUn1tWrite('comp_credits', { status: 201, body: { data: grantedBody() }, expect: want }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('comp_credits', { status: 400, body: { success: false, error: { code: 'USER_NOT_FOUND', message: 'No such user' } }, expect: want }))
      .toMatchObject({ verdict: 'refused', code: 'USER_NOT_FOUND', message: 'No such user' })
  })

  it('the allowlist: POST /credits/grant takes exactly userId, amount, expiresInDays for comp_credits (and trial_regrant still)', async () => {
    const s = await setup()
    const w = await s.deps.writerFactory(s.db, LOC)
    expect(() => w.assertAllowed('comp_credits', 'POST', '/credits/grant', { userId: USER, amount: 2, expiresInDays: 8 })).not.toThrow()
    expect(() => w.assertAllowed('trial_regrant', 'POST', '/credits/grant', { userId: USER, amount: 3, expiresInDays: 7 })).not.toThrow()
    expect(() => w.assertAllowed('comp_credits', 'POST', '/credits/grant', { userId: USER, amount: 2, expiresInDays: 8, reason: 'x' })).toThrow(TypeError)
    expect(() => w.assertAllowed('comp_credits', 'POST', '/credits/grant', { userId: USER, amount: 2, expiresInDays: 8, bypassCredit: true })).toThrow(TypeError)
    expect(() => w.assertAllowed('comp_credits', 'POST', '/bookings', { userId: USER })).toThrow(TypeError)
    expect(() => w.assertAllowed('book', 'POST', '/credits/grant', { userId: USER, amount: 1, expiresInDays: 1 })).toThrow(TypeError)
  })

  it('the ledger key is one per form submission (request id)', () => {
    expect(ledgerKey.comp(LOC, USER, REQ)).toBe(`comp:${LOC}:${USER}:${REQ}`)
    expect(() => ledgerKey.comp(LOC, USER, '')).toThrow(TypeError)
  })
})

describe('grantCompCredits — done', () => {
  it('ONE POST with exactly { userId, amount, expiresInDays }, ledgered with who, why, how many and until when, then the balance mirrored', async () => {
    const s = await setup({ routes: { [GRANT]: [granted()], [CREDITS]: [ok({ balance: 5, is_unlimited: false })] } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'done', id: 'batch-9' })
    expect(r.data).toMatchObject({ expires_at: expect.any(String), original_amount: 2, remaining: 2 })
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === GRANT)
    expect(call.body).toEqual({ userId: USER, amount: 2, expiresInDays: 8 })
    expect(call.headers['idempotency-key']).toBe(`comp:${LOC}:${USER}:${REQ}`)
    const [row] = compRows(s.store)
    expect(row).toMatchObject({
      op: 'comp_credits', origin: 'staff', stage: 'done', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER,
      actor_user_id: 'staff-1', un1t_ref: 'batch-9', idempotency_key: `comp:${LOC}:${USER}:${REQ}`,
      comp_amount: 2, comp_expires_in_days: 8, comp_use_by: '2026-11-05', comp_reason: 'goodwill', comp_note: 'Sorry about Tuesday',
    })
    expect(row.comp_expires_at).toBe(r.data.expires_at)
    expect(s.store.un1t_clients[0].credit_balance).toBe(5)
    expect(s.store.un1t_clients[0].crm_written_at).toBeTruthy()
  })

  it('a blank note is stored as null', async () => {
    const s = await setup({ routes: { [GRANT]: [granted()], [CREDITS]: [ok({ balance: 5, is_unlimited: false })] } })
    await grantCompCredits(s.db, args({ note: '  ' }), s.deps)
    expect(compRows(s.store)[0].comp_note).toBeNull()
  })

  it("un1t.online's refusal is a refusal with its words, on the ledger, and nothing more is sent", async () => {
    const s = await setup({ routes: { [GRANT]: [res(400, { success: false, error: { code: 'USER_NOT_FOUND', message: 'No such user' } })] } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: 'USER_NOT_FOUND', message: 'No such user' })
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    expect(compRows(s.store)[0]).toMatchObject({ stage: 'refused', code: 'USER_NOT_FOUND' })
  })
})

describe('grantCompCredits — never blind re-sent', () => {
  it('5xx, then the check read finds the admin batch since the send → done (landed_after_5xx), one POST, its expiry kept', async () => {
    const batch = grantedBody({ id: 'batch-late', expires_at: expiresIn(8) })
    const s = await setup({ routes: { [GRANT]: [res(500, { message: 'oops' })], [CREDITS]: [ledgerWith([batch])] } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'done', recovered: 'landed_after_5xx', id: 'batch-late' })
    expect(r.data).toMatchObject({ expires_at: batch.expires_at, original_amount: 2 })
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    expect(compRows(s.store)[0]).toMatchObject({ stage: 'done', recovered: 'landed_after_5xx', un1t_ref: 'batch-late', comp_expires_at: batch.expires_at })
  })

  it('5xx, and no matching batch (absent) → unknown, still one POST', async () => {
    const s = await setup({ routes: { [GRANT]: [res(502, {})], [CREDITS]: [ledgerWith([])] } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r.verdict).toBe('unknown')
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    expect(compRows(s.store)[0].stage).toBe('unknown')
  })

  it('5xx, and the check read fails → unknown, still one POST', async () => {
    const s = await setup({ routes: { [GRANT]: [res(500, {})], [CREDITS]: [res(500, {})] } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r.verdict).toBe('unknown')
    expect(s.fetchImpl.count(GRANT)).toBe(1)
  })

  it('the same form submitted again while the first is open sends nothing', async () => {
    const s = await setup({
      routes: { [GRANT]: [granted()] },
      db: { tables: { un1t_write_events: [{
        id: 'open-1', location_id: LOC, op: 'comp_credits', origin: 'staff', idempotency_key: `comp:${LOC}:${USER}:${REQ}`,
        stage: 'sent', created_at: new Date().toISOString(), un1t_user_id: USER,
      }] } },
    })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.ATTEMPT_IN_FLIGHT })
    expect(s.fetchImpl.count(GRANT)).toBe(0)
  })
})

describe('findLandedCompGrant — the check read', () => {
  const sentAt = Date.now() - 5_000
  const check = async (ledger) => {
    const s = await setup({ routes: { [CREDITS]: [ledger] } })
    const w = await s.deps.writerFactory(s.db, LOC)
    return findLandedCompGrant(w, { un1tUserId: USER, amount: 2, expiresInDays: 8, sentAt })
  }
  it('landed: an admin batch of that amount, created since the send, expiring within a day of the requested expiry', async () => {
    const out = await check(ledgerWith([grantedBody({ expires_at: expiresIn(8, sentAt + 3 * 3_600_000) })]))
    expect(out).toMatchObject({ state: 'landed', id: 'batch-9' })
  })
  it('absent: another amount, another source, an older batch, an expiry days off', async () => {
    for (const over of [
      { original_amount: 3 },
      { source: 'purchase' },
      { created_at: new Date(sentAt - 10 * 60_000).toISOString() },
      { expires_at: expiresIn(11, sentAt) },
    ]) {
      expect((await check(ledgerWith([grantedBody(over)]))).state, JSON.stringify(over)).toBe('absent')
    }
  })
  it('unknown: no batch list in the answer, a batch with no readable dates, or a failed read', async () => {
    expect((await check(ok({ balance: 5, is_unlimited: false }))).state).toBe('unknown')
    expect((await check(ledgerWith([grantedBody({ created_at: 'not a date' })]))).state).toBe('unknown')
    expect((await check(res(500, {}))).state).toBe('unknown')
  })
})

describe('grantCompCredits — refused before anything is sent', () => {
  it('writes switched off: refused UN1T_WRITES_OFF, no request at all, no ledger row', async () => {
    const s = await setup({ db: { settings: { un1t_online: { writes_enabled: false } } } })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.WRITES_OFF, sent: false })
    expect(s.fetchImpl.calls).toEqual([])
    expect(compRows(s.store)).toEqual([])
  })

  it('a token without credits:create: refused, nothing sent', async () => {
    const s = await setup({ perms: ALL_PERMS.filter((p) => p !== 'credits:create') })
    const r = await grantCompCredits(s.db, args(), s.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.PERMISSION_MISSING })
    expect(s.fetchImpl.writes()).toEqual([])
  })

  it('the limits are the server\'s, not just the form\'s: a TypeError before any request', async () => {
    const bad = [
      { amount: 0 }, { amount: 11 }, { amount: 1.5 }, { amount: '2' },
      { expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 2.5 },
      { useBy: '2026-02-30' }, { reason: 'because' }, { note: 'x'.repeat(201) }, { note: 'mail jo@example.com' },
      { requestId: '' }, { origin: 'mia' }, { origin: 'approval' }, { actor: null }, { un1tUserId: 'un1t:abc' },
    ]
    for (const over of bad) {
      const s = await setup()
      await expect(grantCompCredits(s.db, args(over), s.deps), JSON.stringify(over)).rejects.toThrow(TypeError)
      expect(s.fetchImpl.calls).toEqual([])
    }
  })
})
