// UN1TWRITE.10 — grantTrial: A's eligibility first, a €0 charge, a
// server-completed free checkout, and a credits read whenever un1t.online's
// answer is in doubt. Never the live API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))
// The refusal table is empty until PR 6: the classifier is mocked so a test
// can say "this code means trial_used" without touching UN1T_REFUSAL_CODES.
vi.mock('./un1t-online-write-judge.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, classifyRefusal: vi.fn(real.classifyRefusal) }
})

import { logError, logWarn, logInfo } from './log'
import { classifyRefusal } from './un1t-online-write-judge.js'
import { createUn1tWriter, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { grantTrial } from './un1t-online-write-ops.js'
import { LOC, STUDIO, USER, PRODUCT, CONTACT, res, ok, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const CHARGE = 'POST /purchases/charge'
const CHECKOUT = 'POST /purchases/checkout'
const PRODUCT_GET = `GET /products/${PRODUCT}`
const CREDITS = `GET /credits/ledgers/${USER}/${STUDIO}`
const CHECKOUT_URL = 'https://pay.example.test/session/secret-session-id'
const TX = 'tx-99'

const liveProduct = (over = {}) => ok({ id: PRODUCT, title: '1) Trial', type: 'one_time', status: 'active', price_amount: 0, price_currency: 'EUR', ...over })
const creditsShow = () => ok({ balance: 3, is_unlimited: false })
const creditsNone = () => ok({ balance: 0, is_unlimited: false })
const refused = (code, message = 'Refused') => res(400, { success: false, error: { code, message } })
const eligible = () => vi.fn(async () => ({ success: true, data: { eligible: true, reasons: [] } }))

async function setup({ routes = {}, db: dbOpts = {}, trialEligibility = eligible() } = {}) {
  const made = makeDb({
    settings: { un1t_online: { writes_enabled: true, trial_product_id: PRODUCT } },
    tables: { un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, credit_balance: 0 }] },
    ...dbOpts,
  })
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes()], [PRODUCT_GET]: [liveProduct()], ...routes })
  const sleep = vi.fn(async () => {})
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep }))
  const deps = { writerFactory, now: () => new Date(), trialEligibility }
  return { ...made, fetchImpl, deps, trialEligibility }
}
const args = (over = {}) => ({ locationId: LOC, un1tUserId: USER, contactId: CONTACT, origin: 'funnel', originRef: 'cbr-1', ...over })
const trialRows = (store) => store.un1t_write_events.filter((r) => r.op === 'trial')
const everyText = (made, out) => JSON.stringify([out, made.store, ...logInfo.mock.calls, ...logWarn.mock.calls, ...logError.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('grantTrial — eligibility first', () => {
  it('not eligible sends nothing and returns ineligible with A\'s first reason', async () => {
    const s = await setup({ trialEligibility: vi.fn(async () => ({ success: true, data: { eligible: false, reasons: ['membership_history', 'paid_pack'] } })) })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'ineligible', reason: 'membership_history' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    expect(s.trialEligibility).toHaveBeenCalledWith(s.db, LOC, { un1tUserId: USER, contactId: CONTACT })
  })

  it('a failed eligibility read returns retry and sends nothing', async () => {
    const s = await setup({ trialEligibility: vi.fn(async () => ({ success: false, error: 'db down' })) })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'retry', code: 'eligibility_unreadable' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })

  it('skipEligibility from any origin but test_account throws; from test_account it skips A', async () => {
    const s = await setup({ routes: { [CHARGE]: [ok({ transactionId: TX })], [CREDITS]: [creditsShow()] } })
    for (const origin of ['funnel', 'approval', 'mia']) {
      await expect(grantTrial(s.db, args({ origin, skipEligibility: true }), s.deps)).rejects.toThrow(TypeError)
    }
    const out = await grantTrial(s.db, args({ origin: 'test_account', skipEligibility: true }), s.deps)
    expect(out.outcome).toBe('granted')
    expect(s.trialEligibility).not.toHaveBeenCalled()
  })
})

describe('grantTrial — the product', () => {
  it('trial_product_id unset returns trial_not_configured and sends nothing', async () => {
    const s = await setup({ db: { settings: { un1t_online: { writes_enabled: true } } } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'trial_not_configured' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })

  for (const [name, over] of [['priced above 0', { price_amount: 1500 }], ['inactive', { status: 'archived' }], ['priced as text', { price_amount: '0' }]]) {
    it(`a product ${name} returns trial_product_not_free and sends nothing`, async () => {
      const s = await setup({ routes: { [PRODUCT_GET]: [liveProduct(over)] } })
      expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'trial_product_not_free' })
      expect(s.fetchImpl.writes()).toHaveLength(0)
    })
  }

  it('an unreadable product returns retry and sends nothing', async () => {
    const s = await setup({ routes: { [PRODUCT_GET]: [res(500, {})] } })
    expect((await grantTrial(s.db, args(), s.deps)).outcome).toBe('retry')
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })
})

describe('grantTrial — the €0 charge', () => {
  it('eligible: a €0 active product is charged once with idempotency-key trial:<loc>:<user>:<product>:charge → granted, un1t_transactions row with crm_written_at, credits refreshed', async () => {
    const s = await setup({ routes: { [CHARGE]: [ok({ transactionId: TX })], [CREDITS]: [creditsShow()] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'granted', method: 'charge' })
    expect(out.ledgerId).toBeTruthy()
    expect(s.fetchImpl.count(CHARGE)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === CHARGE)
    expect(call.body).toEqual({ userId: USER, productId: PRODUCT })
    expect(call.headers['idempotency-key']).toBe(`trial:${LOC}:${USER}:${PRODUCT}:charge`)
    expect(s.fetchImpl.count(CHECKOUT)).toBe(0)
    const tx = s.store.un1t_transactions.find((t) => t.un1t_id === TX)
    expect(tx).toMatchObject({ location_id: LOC, un1t_user_id: USER, contact_id: CONTACT, product_id: PRODUCT, product_title: '1) Trial', amount_cents: 0, currency: 'EUR', type: 'one_time', product_type: 'one_time', raw: { source: 'crm_write' } })
    expect(tx.crm_written_at).toBeTruthy()
    expect(s.store.un1t_clients[0].credit_balance).toBe(3)
    const [row] = trialRows(s.store)
    expect(row).toMatchObject({ stage: 'done', method: 'charge', contact_id: CONTACT, un1t_ref: TX })
  })

  it('limit refusal → ineligible trial_used (the classifier is mocked, never the table)', async () => {
    classifyRefusal.mockImplementation(({ code }) => (code === 'TRIAL_LIMIT' ? 'trial_used' : null))
    const s = await setup({ routes: { [CHARGE]: [refused('TRIAL_LIMIT')] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'ineligible', reason: 'trial_used' })
    expect(s.fetchImpl.count(CHECKOUT)).toBe(0)
    classifyRefusal.mockReset()
  })

  it('charge refused (not the limit) → one free checkout free:true + credits show → granted by free_checkout', async () => {
    const s = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ transactionId: 'tx-free', free: true })], [CREDITS]: [creditsShow()] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'granted', method: 'free_checkout' })
    expect(s.fetchImpl.count(CHECKOUT)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === CHECKOUT)
    expect(call.body).toEqual({ productId: PRODUCT, successUrl: 'https://hatch.example.test/', cancelUrl: 'https://hatch.example.test/', userId: USER })
    expect(call.headers['idempotency-key']).toBe(`trial:${LOC}:${USER}:${PRODUCT}:free_checkout`)
    // Every trial row carries the contact.
    expect(trialRows(s.store).map((r) => [r.method, r.stage, r.contact_id])).toEqual([['charge', 'refused', CONTACT], ['free_checkout', 'done', CONTACT]])
  })

  it('an unmapped charge refusal goes to the free checkout, never to ineligible', async () => {
    // The words say "trial", but the table is empty: never guessed as trial_used.
    const s = await setup({ routes: { [CHARGE]: [refused('TRIAL_LIMIT', 'You have already had your trial')], [CHECKOUT]: [ok({ transactionId: 'tx-free', free: true })], [CREDITS]: [creditsShow()] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out.outcome).toBe('granted')
    expect(s.fetchImpl.count(CHECKOUT)).toBe(1)
  })

  it('charge unknown: credits show → granted; credits do not show → un1t_trial_unverified; the free checkout is never attempted', async () => {
    const a = await setup({ routes: { [CHARGE]: [res(502, {})], [CREDITS]: [creditsShow()] } })
    expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method: 'charge' })
    expect(a.fetchImpl.count(CHARGE)).toBe(1)
    expect(a.fetchImpl.count(CHECKOUT)).toBe(0)
    const b = await setup({ routes: { [CHARGE]: [res(502, {})], [CREDITS]: [creditsNone()] } })
    expect(await grantTrial(b.db, args(), b.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
    expect(b.fetchImpl.count(CHARGE)).toBe(1)
    expect(b.fetchImpl.count(CHECKOUT)).toBe(0)
  })

  it('an unreadable credits read after an unclear charge is retry, and the retry never sends again', async () => {
    const s = await setup({ routes: { [CHARGE]: [res(502, {})], [CREDITS]: [res(500, {}), res(500, {}), res(500, {}), res(500, {}), creditsShow()] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'retry', code: 'credits_unreadable' })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'granted', method: 'charge' })
    expect(s.fetchImpl.count(CHARGE)).toBe(1)
  })

  it('the budget spent before the charge is retry with nothing sent', async () => {
    const s = await setup({ routes: { [CHARGE]: [ok({ transactionId: TX })] }, db: { rate: (n) => (n >= 3 ? 31 : 1) } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'retry', code: 'UN1T_RATE_BUDGET' })
    expect(s.fetchImpl.count(CHARGE)).toBe(0)
  })

  it('writes switched off is needs_staff with the switch code, nothing sent', async () => {
    const s = await setup({ db: { settings: { un1t_online: { writes_enabled: false, trial_product_id: PRODUCT } } } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_failed:UN1T_WRITES_OFF' })
    expect(s.fetchImpl.calls).toHaveLength(0)
  })
})

describe('grantTrial — the free checkout', () => {
  it('a free checkout that answers free:false is un1t_trial_failed and its URL is in no result, ledger row or log', async () => {
    const s = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ checkoutUrl: CHECKOUT_URL, free: false })] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_failed:checkout_not_free' })
    expect(everyText(s, out)).not.toContain('secret-session-id')
  })

  it('a free checkout with no transaction id (an unclear answer) lets the credits read decide', async () => {
    const a = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ free: true })], [CREDITS]: [creditsShow()] } })
    expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method: 'free_checkout' })
    const b = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ checkoutUrl: CHECKOUT_URL })], [CREDITS]: [creditsNone()] } })
    const out = await grantTrial(b.db, args(), b.deps)
    expect(out).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
    expect(everyText(b, out)).not.toContain('secret-session-id')
  })

  it('done and free but credits do not show is un1t_trial_unverified', async () => {
    const s = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ transactionId: 'tx-free', free: true })], [CREDITS]: [creditsNone()] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
  })

  it('limit refusal at the free checkout → ineligible trial_used', async () => {
    classifyRefusal.mockImplementation(({ code }) => (code === 'TRIAL_LIMIT' ? 'trial_used' : null))
    const s = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [refused('TRIAL_LIMIT')] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'ineligible', reason: 'trial_used' })
    classifyRefusal.mockReset()
  })
})

describe('grantTrial — what the ledger already holds', () => {
  const row = (over) => ({
    id: 'tw-1', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER, op: 'trial', origin: 'funnel', target: PRODUCT,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(), finished_at: null, ...over,
  })

  for (const stage of ['sent', 'unknown']) {
    it(`a prior ${stage} trial row: no new send; books only if credits show`, async () => {
      const key = `trial:${LOC}:${USER}:${PRODUCT}:charge`
      const a = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: { un1t_write_events: [row({ stage, method: 'charge', idempotency_key: key })], un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER }] } } })
      expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method: 'charge' })
      expect(a.fetchImpl.writes()).toHaveLength(0)
      const b = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [row({ stage, method: 'charge', idempotency_key: key })] } } })
      expect(await grantTrial(b.db, args(), b.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
      expect(b.fetchImpl.writes()).toHaveLength(0)
    })
  }

  it('a done trial by EITHER method: granted again while its credits show, trial_used once spent; nothing sent', async () => {
    for (const method of ['charge', 'free_checkout']) {
      const tables = () => ({ un1t_write_events: [row({ id: `tw-${method}`, stage: 'done', method, idempotency_key: `trial:${LOC}:${USER}:${PRODUCT}:${method}`, un1t_ref: 'tx-old' })] })
      const a = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: tables() } })
      expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method, ledgerId: `tw-${method}` })
      expect(a.fetchImpl.writes()).toHaveLength(0)
      expect(a.trialEligibility).not.toHaveBeenCalled()
      const b = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: tables() } })
      expect(await grantTrial(b.db, args(), b.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
      expect(b.fetchImpl.writes()).toHaveLength(0)
    }
  })

  it('a sent row another process is still sending (under 3 minutes) is retry in flight, never judged', async () => {
    const s = await setup({ db: { tables: { un1t_write_events: [row({ stage: 'sent', method: 'charge', idempotency_key: `trial:${LOC}:${USER}:${PRODUCT}:charge`, created_at: new Date(Date.now() - 20_000).toISOString() })] } } })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'retry', code: 'UN1T_ATTEMPT_IN_FLIGHT' })
    expect(s.fetchImpl.count(CREDITS)).toBe(0)
  })

  it('an open row whose credits show is settled done; an old one with no credits counts as used', async () => {
    const key = `trial:${LOC}:${USER}:${PRODUCT}:charge`
    const a = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: { un1t_write_events: [row({ stage: 'unknown', method: 'charge', idempotency_key: key })] } } })
    await grantTrial(a.db, args(), a.deps)
    expect(a.store.un1t_write_events[0]).toMatchObject({ stage: 'done', recovered: 'credits_show' })
    const b = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [row({ stage: 'unknown', method: 'charge', idempotency_key: key, created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() })] } } })
    expect(await grantTrial(b.db, args(), b.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
  })
})

describe('grantTrial — the documented free checkout answer', () => {
  it('{ checkoutUrl, free: true } is done: credits show → granted, no failure row, the URL nowhere', async () => {
    const { recordErrorEvent } = await import('./error-events')
    const s = await setup({ routes: { [CHARGE]: [refused('SOMETHING_ELSE')], [CHECKOUT]: [ok({ checkoutUrl: CHECKOUT_URL, free: true })], [CREDITS]: [creditsShow()] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'granted', method: 'free_checkout' })
    expect(trialRows(s.store).find((r) => r.method === 'free_checkout').stage).toBe('done')
    // Only the charge's unmapped refusal leaves a row; the checkout's success never does.
    expect(recordErrorEvent.mock.calls.every(([e]) => !/checkout/.test(JSON.stringify(e)))).toBe(true)
    expect(everyText(s, out)).not.toContain('secret-session-id')
  })

  it('an unreadable customer site rejects before anything is sent', async () => {
    const { resolveCustomerBaseUrl } = await import('./tenant-host.js')
    resolveCustomerBaseUrl.mockRejectedValueOnce(new Error('down'))
    const s = await setup({ routes: { [CHARGE]: [ok({ transactionId: TX })] } })
    await expect(grantTrial(s.db, args(), s.deps)).rejects.toMatchObject({ code: 'customer_url_unreadable' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })
})
