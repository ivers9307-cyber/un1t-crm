// TRIALREGRANT.1 — grantTrial's one-off credit re-grant (Richard, 20 Oct
// 2026): a person who claimed the free trial, never used it and whose credits
// ran out gets 3 credits for 7 days through POST /credits/grant, once ever
// per person per studio. Never the live API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))

import { createUn1tWriter, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { grantTrial, UN1T_TRIAL_REGRANT_CREDITS, UN1T_TRIAL_REGRANT_EXPIRES_IN_DAYS } from './un1t-online-write-ops.js'
import { un1tOnlineReads } from './membership/reads/un1t-online.js'
import { LOC, STUDIO, USER, PRODUCT, CONTACT, OTHER_CONTACT, ALL_PERMS, res, ok, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const GRANT = 'POST /credits/grant'
const CHARGE = 'POST /purchases/charge'
const CHECKOUT = 'POST /purchases/checkout'
const PRODUCT_GET = `GET /products/${PRODUCT}`
const CREDITS = `GET /credits/ledgers/${USER}/${STUDIO}`
const KEY = `trial_regrant:${LOC}:${USER}`

const creditsShow = (balance = 3) => ok({ balance, is_unlimited: false })
const creditsNone = () => ok({ balance: 0, is_unlimited: false })
const granted = () => res(201, { success: true, data: { id: 'batch-1', amount: 3 } })
const refused = (code, message = 'Refused') => res(400, { success: false, error: { code, message } })
// A's answer for the 20 Oct case: the trial used, nothing else, and A says re-grant.
const regrantable = () => vi.fn(async () => ({ success: true, data: { eligible: false, reasons: ['trial_used'], regrant: true } }))

async function setup({ routes = {}, db: dbOpts = {}, trialEligibility = regrantable(), perms = ALL_PERMS } = {}) {
  const made = makeDb({
    settings: { un1t_online: { writes_enabled: true, trial_product_id: PRODUCT } },
    tables: { un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, contact_id: CONTACT, credit_balance: 0 }] },
    ...dbOpts,
  })
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes(perms)], [PRODUCT_GET]: [ok({ id: PRODUCT, status: 'active', price_amount: 0 })], ...routes })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: vi.fn(async () => {}) }))
  const deps = { writerFactory, now: () => new Date(), trialEligibility }
  return { ...made, fetchImpl, deps, trialEligibility }
}
const args = (over = {}) => ({ locationId: LOC, un1tUserId: USER, contactId: CONTACT, origin: 'mia', originRef: 'mia-trial:conv-1', ...over })
const regrantRows = (store) => store.un1t_write_events.filter((r) => r.op === 'trial_regrant')
const ledgerRow = (over) => ({
  id: 'rg-1', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER, op: 'trial_regrant', origin: 'mia', target: null, method: null,
  idempotency_key: KEY, created_at: new Date(Date.now() - 10 * 60_000).toISOString(), finished_at: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('grantTrial — the credit re-grant (TRIALREGRANT.1)', () => {
  it('qualifies: ONE POST /credits/grant { userId, amount 3, expiresInDays 7 } with its ledger key, then granted credit_regrant and the balance mirrored', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] } })
    const out = await grantTrial(s.db, args(), s.deps)
    expect(out).toMatchObject({ outcome: 'granted', method: 'credit_regrant' })
    expect(out.ledgerId).toBeTruthy()
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    const call = s.fetchImpl.calls.find((c) => c.key === GRANT)
    expect(call.body).toEqual({ userId: USER, amount: 3, expiresInDays: 7 })
    expect([UN1T_TRIAL_REGRANT_CREDITS, UN1T_TRIAL_REGRANT_EXPIRES_IN_DAYS]).toEqual([3, 7])
    expect(call.headers['idempotency-key']).toBe(KEY)
    // Never the trial product: no charge, no checkout.
    expect(s.fetchImpl.count(CHARGE) + s.fetchImpl.count(CHECKOUT)).toBe(0)
    expect(regrantRows(s.store)).toEqual([expect.objectContaining({ id: out.ledgerId, stage: 'done', contact_id: CONTACT, un1t_user_id: USER, origin: 'mia', un1t_ref: 'batch-1', method: null })])
    expect(s.store.un1t_clients[0].credit_balance).toBe(3)
    expect(s.store.un1t_clients[0].crm_written_at).toBeTruthy()
  })

  it("the 20 Oct case end to end on A's real read: trial claimed 9 Oct, no bookings, credits 0 → re-granted", async () => {
    const s = await setup({
      trialEligibility: un1tOnlineReads.trialEligibility,
      routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] },
      db: {
        tables: {
          un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, contact_id: CONTACT, credit_balance: 0, credit_unlimited: false }],
          un1t_transactions: [{ id: 'tx-1', location_id: LOC, un1t_id: 'tx-1', un1t_user_id: USER, contact_id: CONTACT, product_id: PRODUCT, product_type: 'pack', type: 'one_time', amount_cents: 0, refunded: false, remote_created_at: '2026-10-09T10:00:00Z' }],
          un1t_products: [{ id: 'p-1', location_id: LOC, un1t_id: PRODUCT, type: 'one_time', price_cents: 0, credits_per_period: 3, title: 'The UN1T Trial' }],
          un1t_bookings: [], un1t_subscriptions: [], contact_memberships: [],
        },
      },
    })
    expect(await grantTrial(s.db, args({ origin: 'funnel' }), s.deps)).toMatchObject({ outcome: 'granted', method: 'credit_regrant' })
    expect(s.fetchImpl.count(GRANT)).toBe(1)

    // ...an attended or no-show class on A's real read is a use: nothing sent;
    // a cancelled one is not.
    for (const [status, sent] of [['attended', 0], ['no_show', 0], ['cancelled', 1]]) {
      const t = await setup({
        trialEligibility: un1tOnlineReads.trialEligibility,
        routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] },
        db: { tables: { ...s.store, un1t_write_events: [], un1t_bookings: [{ id: 'b-1', location_id: LOC, un1t_id: 'b-1', un1t_user_id: USER, contact_id: CONTACT, status }] } },
      })
      t.store.un1t_clients[0].credit_balance = 0
      const out = await grantTrial(t.db, args({ origin: 'funnel' }), t.deps)
      expect(out.outcome, status).toBe(sent ? 'granted' : 'ineligible')
      expect(t.fetchImpl.count(GRANT), status).toBe(sent)
    }
  })

  it('once ever: a second attempt after a re-grant row finds it and sends nothing (trial_used once its credits are gone)', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow(), creditsNone()], [GRANT]: [granted()] } })
    expect((await grantTrial(s.db, args(), s.deps)).outcome).toBe('granted')
    // The class is booked and used; the credits are gone. A asked again would
    // still say regrant (stubbed), but the ledger row settles it first.
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
    expect(s.fetchImpl.count(GRANT)).toBe(1)
    expect(regrantRows(s.store)).toHaveLength(1)
  })

  it('a done re-grant whose credits still show is granted again with nothing sent (a booking retry)', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'done' })] } } })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'granted', method: 'credit_regrant', ledgerId: 'rg-1' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    expect(s.trialEligibility).not.toHaveBeenCalled()
  })

  it("a re-grant on the person's other account (found by contact) counts too", async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'done', un1t_user_id: 'another-account', idempotency_key: `trial_regrant:${LOC}:another-account` })] } } })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    // Another person's re-grant does not.
    const t = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'done', un1t_user_id: 'someone', contact_id: OTHER_CONTACT, idempotency_key: `trial_regrant:${LOC}:someone` })] } } })
    expect((await grantTrial(t.db, args(), t.deps)).method).toBe('credit_regrant')
  })

  it("A says no re-grant (an attended or no-show class, or a re-grant on record) → trial_used, nothing sent", async () => {
    const s = await setup({ trialEligibility: vi.fn(async () => ({ success: true, data: { eligible: false, reasons: ['trial_used'], regrant: false } })) })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    expect(s.fetchImpl.count(CREDITS)).toBe(0)
  })

  it('paid_pack or membership_history beside trial_used → ineligible with that history, nothing sent', async () => {
    for (const reasons of [['trial_used', 'paid_pack'], ['trial_used', 'membership_history'], ['membership_history']]) {
      const s = await setup({ trialEligibility: vi.fn(async () => ({ success: true, data: { eligible: false, reasons, regrant: false } })) })
      expect((await grantTrial(s.db, args(), s.deps)).outcome, reasons.join()).toBe('ineligible')
      expect(s.fetchImpl.writes()).toHaveLength(0)
    }
  })

  it('a live balance above 0 (or unlimited) → trial_used as before, no re-grant', async () => {
    for (const ledger of [creditsShow(1), ok({ balance: 0, is_unlimited: true })]) {
      const s = await setup({ routes: { [CREDITS]: [ledger] } })
      expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
      expect(s.fetchImpl.writes()).toHaveLength(0)
    }
  })

  it('credits unreadable → retry credits_unreadable, nothing sent, no ledger row', async () => {
    const s = await setup({ routes: { [CREDITS]: [res(500, {})] } })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'retry', code: 'credits_unreadable' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    expect(regrantRows(s.store)).toHaveLength(0)
  })

  it("an unreadable eligibility read → retry, nothing sent", async () => {
    const s = await setup({ trialEligibility: vi.fn(async () => ({ success: false, error: 'down' })) })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'retry', code: 'eligibility_unreadable' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })

  it("un1t.online refuses the grant → needs_staff un1t_trial_failed:<code> with the ledger row (refused, so staff may try again)", async () => {
    for (const answer of [refused('CREDIT_GRANT_FAILED', 'Nope'), res(200, { success: false, error: { code: 'CREDIT_GRANT_FAILED', message: 'Nope' } })]) {
      const s = await setup({ routes: { [CREDITS]: [creditsNone()], [GRANT]: [answer] } })
      const out = await grantTrial(s.db, args(), s.deps)
      expect(out).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_failed:CREDIT_GRANT_FAILED', method: 'credit_regrant', message: 'Nope' })
      expect(out.ledgerId).toBeTruthy()
      expect(regrantRows(s.store)).toEqual([expect.objectContaining({ id: out.ledgerId, stage: 'refused', code: 'CREDIT_GRANT_FAILED' })])
      expect(s.fetchImpl.count(GRANT)).toBe(1)
    }
  })

  it('an unclear answer (5xx) is never re-sent: the credits read decides (granted / un1t_trial_unverified / retry, and the retry never sends again)', async () => {
    const a = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [res(502, {})] } })
    expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method: 'credit_regrant' })
    expect(a.fetchImpl.count(GRANT)).toBe(1)
    expect(regrantRows(a.store)[0]).toMatchObject({ stage: 'done', recovered: 'credits_show' })

    const b = await setup({ routes: { [CREDITS]: [creditsNone()], [GRANT]: [res(502, {})] } })
    const out = await grantTrial(b.db, args(), b.deps)
    expect(out).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
    expect(out.ledgerId).toBeTruthy()
    expect(regrantRows(b.store)[0].stage).toBe('unknown')

    const c = await setup({ routes: { [CREDITS]: [creditsNone(), res(500, {}), res(500, {}), res(500, {}), res(500, {}), creditsShow()], [GRANT]: [res(502, {})] } })
    expect(await grantTrial(c.db, args(), c.deps)).toEqual({ outcome: 'retry', code: 'credits_unreadable' })
    expect(await grantTrial(c.db, args(), c.deps)).toMatchObject({ outcome: 'granted', method: 'credit_regrant' })
    expect(c.fetchImpl.count(GRANT)).toBe(1)
  })

  it('a done answer whose credits then read as none is un1t_trial_unverified', async () => {
    const s = await setup({ routes: { [CREDITS]: [creditsNone(), creditsNone()], [GRANT]: [granted()] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified', method: 'credit_regrant' })
  })

  it('an open re-grant row: in flight → retry; in doubt with no credits → unverified (recent) or trial_used (old); never re-sent', async () => {
    const inFlight = await setup({ db: { tables: { un1t_write_events: [ledgerRow({ stage: 'sent', created_at: new Date(Date.now() - 20_000).toISOString() })] } } })
    expect(await grantTrial(inFlight.db, args(), inFlight.deps)).toEqual({ outcome: 'retry', code: 'UN1T_ATTEMPT_IN_FLIGHT' })
    const recent = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'unknown' })] } } })
    expect(await grantTrial(recent.db, args(), recent.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_unverified', ledgerId: 'rg-1' })
    const old = await setup({ routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'unknown', created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() })] } } })
    expect(await grantTrial(old.db, args(), old.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
    const shows = await setup({ routes: { [CREDITS]: [creditsShow()] }, db: { tables: { un1t_write_events: [ledgerRow({ stage: 'unknown' })] } } })
    expect(await grantTrial(shows.db, args(), shows.deps)).toEqual({ outcome: 'granted', method: 'credit_regrant', ledgerId: 'rg-1' })
    expect(shows.store.un1t_write_events[0]).toMatchObject({ stage: 'done', recovered: 'credits_show' })
    for (const s of [inFlight, recent, old, shows]) expect(s.fetchImpl.writes()).toHaveLength(0)
  })

  it('writes switched off → refused as every other op (needs_staff, the switch code), nothing sent', async () => {
    const s = await setup({ db: { settings: { un1t_online: { writes_enabled: false, trial_product_id: PRODUCT } } } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_failed:UN1T_WRITES_OFF' })
    expect(s.fetchImpl.calls).toHaveLength(0)
  })

  it("a token without the re-grant's write permission → needs_staff UN1T_PERMISSION_MISSING, nothing sent, no ledger row", async () => {
    const s = await setup({ perms: ALL_PERMS.filter((p) => p !== 'credits:create'), routes: { [CREDITS]: [creditsNone()] } })
    expect(await grantTrial(s.db, args(), s.deps)).toMatchObject({ outcome: 'needs_staff', reason: 'un1t_trial_failed:UN1T_PERMISSION_MISSING', method: 'credit_regrant' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
    expect(regrantRows(s.store)).toHaveLength(0)
  })

  it('the write budget spent before the grant → retry, nothing sent', async () => {
    // Slots: api-token, the credits read, then the grant (refused by the budget).
    const s = await setup({ routes: { [CREDITS]: [creditsNone()], [GRANT]: [granted()] }, db: { rate: (n) => (n >= 3 ? 31 : 1) } })
    expect(await grantTrial(s.db, args(), s.deps)).toEqual({ outcome: 'retry', code: 'UN1T_RATE_BUDGET' })
    expect(s.fetchImpl.count(GRANT)).toBe(0)
  })

  it('a CRM-granted trial that ran out unused takes the same path (the done-trial ledger branch)', async () => {
    const done = { id: 'tw-1', location_id: LOC, contact_id: CONTACT, un1t_user_id: USER, op: 'trial', origin: 'funnel', target: PRODUCT, method: 'charge', stage: 'done', idempotency_key: `trial:${LOC}:${USER}:${PRODUCT}:charge`, un1t_ref: 'tx-old', created_at: new Date(Date.now() - 20 * 86_400_000).toISOString() }
    const a = await setup({ routes: { [CREDITS]: [creditsNone(), creditsShow()], [GRANT]: [granted()] }, db: { tables: { un1t_write_events: [done] } } })
    expect(await grantTrial(a.db, args(), a.deps)).toMatchObject({ outcome: 'granted', method: 'credit_regrant' })
    // One credits read before the grant (the done trial's), one after.
    expect(a.fetchImpl.count(CREDITS)).toBe(2)
    expect(a.fetchImpl.count(GRANT)).toBe(1)
    expect(a.trialEligibility).toHaveBeenCalledWith(a.db, LOC, { un1tUserId: USER, contactId: CONTACT })
    // A says no → trial_used, as before.
    const b = await setup({ trialEligibility: vi.fn(async () => ({ success: true, data: { eligible: false, reasons: ['trial_used'], regrant: false } })), routes: { [CREDITS]: [creditsNone()] }, db: { tables: { un1t_write_events: [done] } } })
    expect(await grantTrial(b.db, args(), b.deps)).toEqual({ outcome: 'ineligible', reason: 'trial_used' })
    expect(b.fetchImpl.writes()).toHaveLength(0)
  })

  it('an unreadable re-grant history rejects before anything is sent (never "no re-grant")', async () => {
    const s = await setup({ db: { fail: { 'un1t_write_events.select': { code: 'XX000' } } } })
    await expect(grantTrial(s.db, args(), s.deps)).rejects.toMatchObject({ code: 'XX000' })
    expect(s.fetchImpl.writes()).toHaveLength(0)
  })
})
