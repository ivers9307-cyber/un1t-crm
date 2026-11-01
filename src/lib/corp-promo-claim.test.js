// CORPPROMO.1 — fulfilCorpPromoClaim: account, eligibility, grant, stamp, tell.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-settings', () => ({
  Un1tSettingsReadError: class Un1tSettingsReadError extends Error {},
  readUn1tWriteSettings: vi.fn(async () => ({ settings: { sendsWelcome: false, welcomeSetsLogin: false } })),
}))
vi.mock('@/lib/un1t-online-write', () => ({ Un1tWriteRefused: class Un1tWriteRefused extends Error {} }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ grantPromoCredits: vi.fn(), UN1T_PROMO_ORIGIN: 'corp_promo' }))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: vi.fn(), runSetPasswordStep: vi.fn() }))
// CLASSFIRST.1 — the funded booking after the grant (its own tests beside it).
vi.mock('@/lib/class-first-booking', async (importOriginal) => ({ ...(await importOriginal()), queueFundedClassBooking: vi.fn(async () => ({ queued: true, id: 'cbr-1' })) }))

import { fulfilCorpPromoClaim } from './corp-promo-claim'
import { resolveCorpPromo, corpPromoCopyFromBlocks } from './corp-promos'
import { queueFundedClassBooking } from '@/lib/class-first-booking'

const PROMO = resolveCorpPromo('hatch-3-free')
const COPY = corpPromoCopyFromBlocks([], PROMO.key)

function fakeDb({ updateError = null } = {}) {
  const updates = []
  const db = {
    from: (table) => ({
      update: (patch) => {
        const q = { eq: () => q, then: (ok, no) => { updates.push({ table, patch }); const e = typeof updateError === 'function' ? updateError(patch) : updateError; return Promise.resolve({ data: null, error: e }).then(ok, no) } }
        return q
      },
    }),
  }
  return { db, updates }
}

const claim = { id: 'claim-1', location_id: 'loc-h', first_name: 'Ann', last_name: 'Byrne', customer_email: 'ann@work.ie', customer_phone: '0871234567', terms_accepted_at: '2026-10-28T10:00:00Z' }
const location = { id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org-1' }
const contact = { id: 'c-1', email: 'ann@work.ie', first_name: 'Ann', last_name: 'Byrne' }

function deps(over = {}) {
  return {
    ensureUn1tAccount: vi.fn(async () => ({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' })),
    corpPromoEligibility: vi.fn(async () => ({ ok: true, eligible: true })),
    grantPromoCredits: vi.fn(async () => ({ outcome: 'granted', ledgerId: 'pg-1', batchId: 'b-1', expiresAt: '2026-11-04T10:00:00.000Z' })),
    runSetPasswordStep: vi.fn(async (_db, _a, { sendUn1tAccountEmail }) => { await sendUn1tAccountEmail(); return { explanation: 'sent', forgotPassword: 'done' } }),
    sendCorpPromoEmail: vi.fn(async () => ({ sent: true })),
    sendOpsAlert: vi.fn(async () => {}),
    now: () => new Date('2026-10-28T10:00:00Z'),
    ...over,
  }
}
const run = (d, db = fakeDb().db) => fulfilCorpPromoClaim(db, { claim, location, contact, promo: PROMO, copy: COPY, zone: 'Europe/Dublin', trialProductId: 'tp' }, d)
const lastStatus = (updates) => updates.filter((u) => u.patch.status).at(-1)?.patch

beforeEach(() => vi.clearAllMocks())

describe('fulfilCorpPromoClaim — CLASSFIRST.1, the class they picked', () => {
  const withClass = { ...claim, contact_id: 'c-1', page_id: 'p-c', class_event_id: 'un1t:ev-1', class_name: 'RALLY', class_starts_at: '2099-01-07T18:00:00.000Z' }
  it('a granted claim with a class queues one funded booking after the grant, before the email', async () => {
    const f = fakeDb()
    const d = deps()
    const r = await fulfilCorpPromoClaim(f.db, { claim: withClass, location, contact, promo: PROMO, copy: COPY, zone: 'Europe/Dublin', trialProductId: 'tp' }, d)
    expect(r.kind).toBe('granted')
    expect(queueFundedClassBooking).toHaveBeenCalledTimes(1)
    expect(queueFundedClassBooking).toHaveBeenCalledWith(f.db, expect.objectContaining({
      fundedBy: 'corp_promo', fundedById: 'claim-1', locationId: 'loc-h', contactId: 'c-1', pageId: 'p-c',
      eventId: 'un1t:ev-1', className: 'RALLY', startsAt: '2099-01-07T18:00:00.000Z',
      customer: { name: 'Ann Byrne', email: 'ann@work.ie', phone: '0871234567' },
      terms: { terms_accepted_at: '2026-10-28T10:00:00Z', terms_source: null, terms_version: null },
    }))
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })
  it('no class, an ineligible claim or a refused grant queues nothing', async () => {
    await run(deps())
    expect(queueFundedClassBooking).not.toHaveBeenCalled()
    await fulfilCorpPromoClaim(fakeDb().db, { claim: withClass, location, contact, promo: PROMO, copy: COPY, zone: 'Europe/Dublin', trialProductId: 'tp' }, deps({ grantPromoCredits: vi.fn(async () => ({ outcome: 'ineligible', reason: 'trained' })) }))
    expect(queueFundedClassBooking).not.toHaveBeenCalled()
  })
  it('a queue helper that throws never undoes the grant or the email', async () => {
    queueFundedClassBooking.mockRejectedValueOnce(new Error('down'))
    const d = deps()
    const r = await fulfilCorpPromoClaim(fakeDb().db, { claim: withClass, location, contact, promo: PROMO, copy: COPY, zone: 'Europe/Dublin', trialProductId: 'tp' }, d)
    expect(r.kind).toBe('granted')
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })
})

describe('fulfilCorpPromoClaim', () => {
  it('granted: 3 credits for 7 days to the account, the row stamped, one confirmation email', async () => {
    const f = fakeDb()
    const d = deps()
    expect(await run(d, f.db)).toEqual({ kind: 'granted', expiresAt: '2026-11-04T10:00:00.000Z', credits: 3 })
    expect(d.grantPromoCredits).toHaveBeenCalledWith(f.db, expect.objectContaining({ un1tUserId: 'u-1', promoKey: 'hatch-3-free', amount: 3, expiresInDays: 7, originRef: 'claim-1' }))
    expect(lastStatus(f.updates)).toMatchObject({ status: 'granted', un1t_user_id: 'u-1', un1t_ledger_id: 'pg-1', credits: 3, expires_at: '2026-11-04T10:00:00.000Z' })
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
    expect(d.runSetPasswordStep).not.toHaveBeenCalled()
  })

  it('a new account: the confirmation rides the set-password step, sent once', async () => {
    const d = deps({ ensureUn1tAccount: vi.fn(async () => ({ kind: 'created', un1tUserId: 'u-1', executingContactId: 'c-1' })) })
    await run(d)
    expect(d.runSetPasswordStep).toHaveBeenCalledTimes(1)
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })

  it('a new account: the app links reach the confirmation email', async () => {
    const appLinks = { iosUrl: 'https://apps.apple.com/x', androidUrl: null }
    const d = deps({
      ensureUn1tAccount: vi.fn(async () => ({ kind: 'created', un1tUserId: 'u-1', executingContactId: 'c-1' })),
      runSetPasswordStep: vi.fn(async (_db, _a, { sendUn1tAccountEmail }) => { await sendUn1tAccountEmail({}, { appLinks }); return { explanation: 'sent' } }),
    })
    await run(d)
    expect(d.sendCorpPromoEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ appLinks }))
  })

  it('a new account whose step did not send our email: sent directly', async () => {
    const d = deps({
      ensureUn1tAccount: vi.fn(async () => ({ kind: 'created', un1tUserId: 'u-1', executingContactId: 'c-1' })),
      runSetPasswordStep: vi.fn(async () => ({ explanation: 'skipped_flag', forgotPassword: 'skipped_flag' })),
    })
    await run(d)
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })

  it('no expiry on the answer: now + 7 days', async () => {
    const d = deps({ grantPromoCredits: vi.fn(async () => ({ outcome: 'granted', ledgerId: 'pg-1', batchId: null, expiresAt: null })) })
    expect((await run(d)).expiresAt).toBe('2026-11-04T10:00:00.000Z')
  })

  it("the account's history shows them trained: ineligible, nothing granted", async () => {
    const f = fakeDb()
    const d = deps({ corpPromoEligibility: vi.fn(async () => ({ ok: true, eligible: false, reason: 'trained' })) })
    expect(await run(d, f.db)).toEqual({ kind: 'ineligible', reason: 'trained' })
    expect(d.grantPromoCredits).not.toHaveBeenCalled()
    expect(lastStatus(f.updates)).toMatchObject({ status: 'ineligible', reason: 'trained' })
  })

  it('an unreadable eligibility read: try again, nothing granted', async () => {
    const d = deps({ corpPromoEligibility: vi.fn(async () => ({ ok: false })) })
    expect(await run(d)).toEqual({ kind: 'unavailable' })
    expect(d.grantPromoCredits).not.toHaveBeenCalled()
  })

  it('credits already on the account: ineligible holds_credits', async () => {
    const d = deps({ grantPromoCredits: vi.fn(async () => ({ outcome: 'ineligible', reason: 'holds_credits' })) })
    expect(await run(d)).toEqual({ kind: 'ineligible', reason: 'holds_credits' })
  })

  it('an account card or a grant in doubt: help_requested and the ops alert', async () => {
    const a = fakeDb()
    const d1 = deps({ ensureUn1tAccount: vi.fn(async () => ({ kind: 'card', reason: 'account_ambiguous' })) })
    expect(await run(d1, a.db)).toEqual({ kind: 'help_filed' })
    expect(lastStatus(a.updates)).toMatchObject({ status: 'help_requested', reason: 'un1t_account_refused: account_ambiguous' })
    expect(d1.sendOpsAlert).toHaveBeenCalledTimes(1)
    const b = fakeDb()
    const d2 = deps({ grantPromoCredits: vi.fn(async () => ({ outcome: 'needs_staff', reason: 'un1t_promo_unverified', ledgerId: 'pg-1' })) })
    expect(await run(d2, b.db)).toEqual({ kind: 'help_filed' })
    expect(lastStatus(b.updates)).toMatchObject({ status: 'help_requested', reason: 'un1t_promo_unverified', un1t_ledger_id: 'pg-1' })
    expect(d2.sendCorpPromoEmail).not.toHaveBeenCalled()
  })

  it('a retry from the account or the grant: failed, try again', async () => {
    const f = fakeDb()
    expect(await run(deps({ ensureUn1tAccount: vi.fn(async () => ({ kind: 'retry', code: 'rate_budget' })) }), f.db)).toEqual({ kind: 'unavailable' })
    expect(lastStatus(f.updates)).toMatchObject({ status: 'failed', reason: 'rate_budget' })
    expect(await run(deps({ grantPromoCredits: vi.fn(async () => ({ outcome: 'retry', code: 'credits_unreadable' })) }))).toEqual({ kind: 'unavailable' })
  })

  it('a second granted claim for the person (unique index): already_claimed, no second email', async () => {
    const f = fakeDb({ updateError: (patch) => (patch.status === 'granted' ? { code: '23505' } : null) })
    const d = deps()
    expect(await run(d, f.db)).toEqual({ kind: 'ineligible', reason: 'already_claimed' })
    expect(d.sendCorpPromoEmail).not.toHaveBeenCalled()
  })

  it('the email failing never undoes the grant', async () => {
    const d = deps({ sendCorpPromoEmail: vi.fn(async () => { throw new Error('postmark down') }) })
    expect((await run(d)).kind).toBe('granted')
  })
})
