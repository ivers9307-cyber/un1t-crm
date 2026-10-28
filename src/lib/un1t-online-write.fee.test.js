// FEES.1 — chargeClassFee: a staff-reviewed late-cancel / no-show fee on the
// member's default card through POST /purchases/charge-custom (Richard, 28 Oct
// 2026). Never the live API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))

import { createUn1tWriter, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { chargeClassFee, FEE_NO_CARD } from './un1t-online-write-ops.js'
import { LOC, USER, CONTACT, ALL_PERMS, res, ok, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const CHARGE = 'POST /purchases/charge-custom'
const CARDS = `GET /payment-methods/client/${USER}`
const FEE = '11111111-2222-3333-4444-555555555555'
const KEY = `fee:${LOC}:${FEE}:1`
const DESCRIPTION = 'No-show: Strength, Wed 28 Oct 2026, 18:30'
const PERMS = [...ALL_PERMS, 'payment_methods:read']

const card = (over = {}) => ({ id: 'pm-1', is_default: true, is_expired: false, last4: '2613', brand: 'mastercard', ...over })
const charged = (id = 'tx-1') => res(201, { success: true, data: { transactionId: id } })

async function setup({ routes = {}, perms = PERMS, db: dbOpts = {} } = {}) {
  const made = makeDb({ settings: { un1t_online: { writes_enabled: true } }, ...dbOpts })
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes(perms)], ...routes })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: vi.fn(async () => {}) }))
  return { ...made, fetchImpl, deps: { writerFactory } }
}
const args = (over = {}) => ({
  locationId: LOC, contactId: CONTACT, un1tUserId: USER, feeId: FEE, attempt: 1,
  amountCents: 1500, description: DESCRIPTION, origin: 'fee_run', ...over,
})
const feeRows = (store) => store.un1t_write_events.filter((r) => r.op === 'fee_charge')

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('chargeClassFee (FEES.1)', () => {
  it('checks the card, then sends ONE charge-custom with the body, the key and no card id', async () => {
    const s = await setup({ routes: { [CARDS]: [ok([card()])], [CHARGE]: [charged()] } })
    const out = await chargeClassFee(s.db, args(), s.deps)
    expect(out).toMatchObject({ verdict: 'done', id: 'tx-1' })
    expect(s.fetchImpl.count(CHARGE)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === CHARGE)
    expect(call.body).toEqual({ userId: USER, amount: 1500, currency: 'eur', description: DESCRIPTION })
    expect(call.headers['idempotency-key']).toBe(KEY)
    expect(feeRows(s.store)).toEqual([expect.objectContaining({ stage: 'done', un1t_ref: 'tx-1', origin: 'fee_run', target: FEE, un1t_user_id: USER })])
  })

  it('no usable card: refused NO_CARD_ON_FILE and nothing is sent', async () => {
    for (const cards of [[], [card({ is_expired: true })], [card({ is_default: false }), card({ id: 'pm-2', is_default: false })]]) {
      const s = await setup({ routes: { [CARDS]: [ok(cards)] } })
      const out = await chargeClassFee(s.db, args(), s.deps)
      expect(out).toMatchObject({ verdict: 'refused', code: FEE_NO_CARD })
      expect(out.retryable).toBe(false)
      expect(s.fetchImpl.count(CHARGE)).toBe(0)
      expect(feeRows(s.store)).toHaveLength(0)
    }
  })

  it('an unreadable card check refuses retryable and sends nothing', async () => {
    const s = await setup({ routes: { [CARDS]: [res(500, {}), res(500, {}), res(500, {}), res(500, {})] } })
    const out = await chargeClassFee(s.db, args(), s.deps)
    expect(out).toMatchObject({ verdict: 'refused', code: 'card_read_failed', retryable: true })
    expect(s.fetchImpl.count(CHARGE)).toBe(0)
  })

  it("un1t.online's refusal (402 NO_CARD_ON_FILE, seen 28 Oct) is refused with its code and words", async () => {
    const s = await setup({ routes: {
      [CARDS]: [ok([card()])],
      [CHARGE]: [res(402, { success: false, error: { status: 402, message: 'This client has no card on file. Request a card from them first.', details: { code: 'NO_CARD_ON_FILE' } } })],
    } })
    const out = await chargeClassFee(s.db, args(), s.deps)
    expect(out.verdict).toBe('refused')
    expect(out.message).toMatch(/no card on file/)
    expect(s.fetchImpl.count(CHARGE)).toBe(1)
    expect(feeRows(s.store)[0].stage).toBe('refused')
  })

  it('a 5xx is re-sent once with the SAME key (un1t.online answers the same transaction)', async () => {
    const s = await setup({ routes: { [CARDS]: [ok([card()])], [CHARGE]: [res(502, {}), charged('tx-9')] } })
    const out = await chargeClassFee(s.db, args(), s.deps)
    expect(out).toMatchObject({ verdict: 'done', id: 'tx-9' })
    const keys = s.fetchImpl.calls.filter((c) => c.key === CHARGE).map((c) => c.headers['idempotency-key'])
    expect(keys).toEqual([KEY, KEY])
  })

  it('a resume skips the card check and resends the open attempt with its key', async () => {
    const s = await setup({
      routes: { [CHARGE]: [charged('tx-2')] },
      db: { tables: { un1t_write_events: [{
        id: 'led-1', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER, op: 'fee_charge', origin: 'fee_run', target: FEE, method: null,
        idempotency_key: KEY, stage: 'unknown', created_at: new Date(Date.now() - 30 * 60_000).toISOString(), finished_at: null,
      }] } },
    })
    const out = await chargeClassFee(s.db, args({ resume: true }), s.deps)
    expect(out).toMatchObject({ verdict: 'done', id: 'tx-2' })
    expect(s.fetchImpl.count(CARDS)).toBe(0)
    expect(s.fetchImpl.calls.find((c) => c.key === CHARGE).headers['idempotency-key']).toBe(KEY)
  })

  it('the second attempt has its own key', async () => {
    const s = await setup({ routes: { [CARDS]: [ok([card()])], [CHARGE]: [charged()] } })
    await chargeClassFee(s.db, args({ attempt: 2 }), s.deps)
    expect(s.fetchImpl.calls.find((c) => c.key === CHARGE).headers['idempotency-key']).toBe(`fee:${LOC}:${FEE}:2`)
  })

  it('writes off or a missing permission sends nothing', async () => {
    const off = await setup({ db: { settings: { un1t_online: { writes_enabled: false } } } })
    expect(await chargeClassFee(off.db, args(), off.deps)).toMatchObject({ verdict: 'refused', code: 'UN1T_WRITES_OFF' })
    const noPerm = await setup({ perms: ALL_PERMS.filter((p) => p !== 'payment_methods:read') })
    expect(await chargeClassFee(noPerm.db, args(), noPerm.deps)).toMatchObject({ verdict: 'refused', code: 'UN1T_PERMISSION_MISSING' })
    expect(off.fetchImpl.writes().length + noPerm.fetchImpl.writes().length).toBe(0)
  })

  it('refuses bad arguments before anything is read', async () => {
    const s = await setup()
    await expect(chargeClassFee(s.db, args({ amountCents: 0 }), s.deps)).rejects.toBeInstanceOf(TypeError)
    await expect(chargeClassFee(s.db, args({ amountCents: 100_001 }), s.deps)).rejects.toBeInstanceOf(TypeError)
    await expect(chargeClassFee(s.db, args({ description: ' ' }), s.deps)).rejects.toBeInstanceOf(TypeError)
    await expect(chargeClassFee(s.db, args({ origin: 'mia' }), s.deps)).rejects.toBeInstanceOf(TypeError)
    expect(s.fetchImpl.calls).toHaveLength(0)
  })
})
