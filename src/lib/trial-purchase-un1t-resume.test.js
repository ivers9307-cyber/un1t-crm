// HATCHTRACK.1 — "Continue to payment" for a Hatch Street trial: the same row
// goes back to payment. What it pins:
//   - only an unpaid Hatch row that carries its un1t.online account;
//   - NEVER a checkout for someone who has paid, or who cannot be told from
//     someone who has: a checkout minted before the paid=1 return, a payment
//     in the mirror, credits or a subscription on the live account, or any of
//     those reads failing (unknown is not unpaid);
//   - the row's own recent checkout is handed back with no write; otherwise a
//     fresh checkout for the SAME row and account under an attempt-scoped key;
//   - the row's status is never changed, whatever un1t.online answers; no
//     account is made, nothing is charged or granted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const mocks = vi.hoisted(() => ({ baseUrl: vi.fn(), ensureAccount: vi.fn(), alert: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.baseUrl }))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: mocks.ensureAccount }))
vi.mock('@/lib/trial-purchase-processor', () => ({ alertTrialPurchaseStaff: mocks.alert }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: vi.fn(() => { throw new Error('the real primitive must be injected in this test') }) }))
vi.mock('@/lib/agent/un1t-member-read', () => ({ fetchLiveEntitlement: vi.fn(() => { throw new Error('the live read must be injected in this test') }) }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.warn, logError: mocks.error, logInfo: vi.fn() }))

import { resumeUn1tTrialCheckout, un1tRetryGate } from './trial-purchase-un1t-resume'
import { un1tTrialCheckoutKey, isPaidAwareCheckoutKey } from './trial-purchase-un1t-checkout'
import { UN1T_CHECKOUT_REUSE_MS, UN1T_TRIAL_RESUME_MAX_AGE_MS } from './trial-checkout-window'

const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const ID = '11111111-1111-4111-8111-111111111111'
const ROW = {
  id: ID, location_id: 'loc2', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'un1t_online',
  un1t_user_id: 'u-77', un1t_product_id: 'prod-1', created_at: ago(30 * MIN),
}
const KEY = (n) => `trial_purchase:${ID}:r${n}`
const LEGACY_KEY = `trial_purchase:${ID}`
const event = (over = {}) => ({ id: 'led-1', stage: 'done', checkout_url: 'https://checkout.stripe.com/c/pay/first', idempotency_key: KEY(0), created_at: ago(30 * MIN), ...over })
const tx = (over = {}) => ({ un1t_id: 'tx1', product_id: 'prod-1', type: 'purchase', amount_cents: 3900, remote_created_at: ago(5 * MIN), ...over })
const NOTHING = { ok: true, balance: 0, unlimited: false, liveSubscriptionIds: [] }

// `stampHits`: how many rows the guarded ledger-id stamp matches (0 = the row was settled meanwhile).
function makeDb({ row = ROW, ledger = [event()], txs = [], fail = {}, stampHits = 1 } = {}) {
  const reads = []
  const updates = []
  const db = {
    reads, updates,
    from: (table) => {
      const filters = []
      let patch = null
      let cols = null
      const settle = async () => {
        if (patch) {
          updates.push({ table, patch, filters: [...filters] })
          return fail.update ? { data: null, error: { code: 'XX000' } } : { data: Array.from({ length: stampHits }, () => ({ id: ID })), error: null }
        }
        reads.push({ table, cols, filters: [...filters] })
        if (fail[table]) return { data: null, error: { code: 'XX000' } }
        if (table === 'trial_purchases') return { data: row, error: null }
        if (table === 'un1t_write_events') return { data: ledger, error: null }
        if (table === 'un1t_transactions') return { data: txs, error: null }
        throw new Error(`unexpected read of ${table}`)
      }
      const b = {
        select: (c) => { if (!patch) cols = c; return b },
        update: (p) => { patch = p; return b },
        maybeSingle: () => settle(),
        then: (res, rej) => settle().then(res, rej),
      }
      for (const op of ['eq', 'gte', 'order', 'range']) b[op] = (...args) => { filters.push([op, ...args]); return b }
      return b
    },
  }
  return db
}

const createLink = vi.fn()
const liveEntitlement = vi.fn()
const run = (db, over = {}) => resumeUn1tTrialCheckout(db, { purchaseId: ID, returnPath: '/hatch-street', now: () => NOW, ...over }, { createLink, liveEntitlement })
const stale = (over = {}) => makeDb({ ledger: [event({ created_at: ago(60 * MIN) })], ...over })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.baseUrl.mockResolvedValue('https://www.un1tdublin.com')
  createLink.mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/c/pay/fresh', free: false, ledgerId: 'led-2' })
  liveEntitlement.mockResolvedValue(NOTHING)
})

describe('the checkout key', () => {
  it('every checkout minted with the paid=1 return carries :r<n>; the old bare key does not', () => {
    expect(un1tTrialCheckoutKey(ID, 0)).toBe(KEY(0))
    expect(isPaidAwareCheckoutKey(KEY(0))).toBe(true)
    expect(isPaidAwareCheckoutKey(KEY(12))).toBe(true)
    for (const k of [LEGACY_KEY, `${LEGACY_KEY}:r`, `${LEGACY_KEY}:x1`, `offer:${ID}:r1`, '', null, undefined, 7]) expect(isPaidAwareCheckoutKey(k)).toBe(false)
  })
})

describe('resumeUn1tTrialCheckout — which rows', () => {
  it('an unknown purchase is not_found; an unreadable one is unavailable; neither reads further or writes', async () => {
    const none = makeDb({ row: null })
    expect(await run(none)).toEqual({ kind: 'not_found' })
    const down = makeDb({ fail: { trial_purchases: true } })
    expect(await run(down)).toEqual({ kind: 'unavailable', code: 'row_unreadable' })
    expect(createLink).not.toHaveBeenCalled()
    expect(liveEntitlement).not.toHaveBeenCalled()
    expect([...none.updates, ...down.updates]).toHaveLength(0)
  })

  it('reads the row by its id alone, naming no column that holds the buyer', async () => {
    const db = makeDb()
    await run(db)
    expect(db.reads[0]).toMatchObject({ table: 'trial_purchases', filters: [['eq', 'id', ID]] })
    const rowCols = db.reads[0].cols.split(',').map((c) => c.trim())
    for (const c of ['*', 'customer_name', 'customer_email', 'customer_phone', 'first_name', 'last_name', 'attribution', 'contact_id']) expect(rowCols).not.toContain(c)
  })

  it.each([
    ['a Stillorgan row', { payment_provider: 'revolut' }, 'pending'],
    ['a row already settled', { status: 'granted', payment_status: 'paid' }, 'granted'],
    ['an expired row', { status: 'expired' }, 'expired'],
    ['a row with the team', { status: 'help_requested' }, 'help'],
    ['a row with no un1t.online account yet', { un1t_user_id: null }, 'pending'],
    ['a row with no product', { un1t_product_id: null }, 'pending'],
    ['a row past the resume age', { created_at: ago(UN1T_TRIAL_RESUME_MAX_AGE_MS + MIN) }, 'pending'],
  ])('%s is not_resumable: no further read, no checkout, no write', async (_n, over, state) => {
    const db = makeDb({ row: { ...ROW, ...over } })
    expect(await run(db)).toEqual({ kind: 'not_resumable', state })
    expect(db.reads).toHaveLength(1)
    expect(createLink).not.toHaveBeenCalled()
    expect(liveEntitlement).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })
})

// A second un1t.online payment settles no row and needs a refund by hand.
describe('resumeUn1tTrialCheckout — never a checkout for someone who has paid', () => {
  const noCheckout = (db) => {
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  }

  it('a payment in the mirror since the row was made: confirming, for a stored checkout and a fresh one alike', async () => {
    for (const db of [makeDb({ txs: [tx()], ledger: [event({ created_at: ago(MIN) })] }), stale({ txs: [tx()] })]) {
      createLink.mockClear()
      expect(await run(db)).toEqual({ kind: 'confirming', reason: 'paid_in_mirror' })
      noCheckout(db)
    }
  })

  it('the mirror is read for this studio, this un1t.online user, since the row was made', async () => {
    const db = makeDb()
    await run(db)
    const read = db.reads.find((r) => r.table === 'un1t_transactions')
    expect(read.filters).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'loc2'], ['eq', 'un1t_user_id', 'u-77'], ['gte', 'remote_created_at', ROW.created_at],
    ]))
  })

  it("a transaction with no product counts as paid (the settle sweep's fallback); a €0 one, a renewal or another product does not", async () => {
    expect(await run(stale({ txs: [tx({ product_id: null })] }))).toEqual({ kind: 'confirming', reason: 'paid_in_mirror' })
    for (const t of [tx({ amount_cents: 0 }), tx({ type: 'sub_renewal' }), tx({ product_id: 'a-class-pack' })]) {
      expect(await run(stale({ txs: [t] }))).toMatchObject({ kind: 'redirect' })
    }
  })

  it('a checkout minted before the paid=1 return existed: confirming (its return cannot be told from a paid one), never a pay button', async () => {
    for (const ledger of [[event({ idempotency_key: LEGACY_KEY, created_at: ago(MIN) })], [event({ idempotency_key: LEGACY_KEY, created_at: ago(20 * 60 * MIN) })]]) {
      const db = makeDb({ ledger })
      expect(await run(db)).toEqual({ kind: 'confirming', reason: 'legacy_checkout' })
      noCheckout(db)
      // Decided off the ledger alone: no mirror or live read is needed to refuse.
      expect(db.reads.map((r) => r.table)).toEqual(['trial_purchases', 'un1t_write_events'])
    }
  })

  it('a paid-aware checkout made after an old one (the buyer continued once already) is judged on the newest', async () => {
    const ledger = [event({ id: 'l2', idempotency_key: KEY(1), created_at: ago(MIN), checkout_url: 'https://checkout.stripe.com/c/pay/second' }), event({ idempotency_key: LEGACY_KEY })]
    expect(await run(makeDb({ ledger }))).toMatchObject({ kind: 'redirect', reused: true, checkoutUrl: 'https://checkout.stripe.com/c/pay/second' })
  })

  it("credits, unlimited or a live subscription on un1t.online's own ledger: confirming (the mirror has not caught up)", async () => {
    for (const ent of [{ ...NOTHING, balance: 10 }, { ...NOTHING, balance: 1 }, { ...NOTHING, balance: null, unlimited: true }, { ...NOTHING, liveSubscriptionIds: ['sub-1'] }]) {
      liveEntitlement.mockResolvedValueOnce(ent)
      const db = stale()
      expect(await run(db)).toEqual({ kind: 'confirming', reason: 'holds_credits' })
      noCheckout(db)
    }
    expect(liveEntitlement).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc2', un1tUserId: 'u-77' })
  })

  it.each([
    ['the checkout ledger', { fail: { un1t_write_events: true } }, null],
    ['the transactions mirror', { fail: { un1t_transactions: true } }, null],
    ['the live credits read (not connected)', {}, { ok: false, reason: 'not_connected' }],
    ['the live credits read (budget spent)', {}, { ok: false, reason: 'budget_spent' }],
    ['the live credits read (failed)', {}, { ok: false, reason: 'read_failed' }],
    ['the live credits read (no answer at all)', {}, null],
  ])('%s unreadable: unknown is not unpaid. No checkout, the buyer is asked to try again in a minute', async (_n, dbOver, ent) => {
    if (_n.startsWith('the live')) liveEntitlement.mockResolvedValueOnce(ent)
    const db = stale(dbOver)
    expect(await run(db)).toEqual({ kind: 'confirming', reason: 'read_failed', retryLater: true })
    noCheckout(db)
  })

  it('a live read that throws is the same: no checkout', async () => {
    liveEntitlement.mockRejectedValueOnce(new Error('network'))
    const db = stale()
    expect(await run(db)).toEqual({ kind: 'confirming', reason: 'read_failed', retryLater: true })
    noCheckout(db)
  })

  it('a row settled while un1t.online was making the checkout (the guarded stamp matches nothing) hands no checkout out', async () => {
    const db = stale({ stampHits: 0 })
    expect(await run(db)).toEqual({ kind: 'confirming', reason: 'paid_in_mirror' })
    expect(createLink).toHaveBeenCalledTimes(1)
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([['eq', 'status', 'awaiting_payment']]))
  })

  it('un1tRetryGate without `live` (the status route) makes no call to un1t.online and still refuses a paid or legacy row', async () => {
    expect(await un1tRetryGate(makeDb(), ROW, { nowMs: NOW }, { liveEntitlement })).toMatchObject({ ok: true })
    expect(await un1tRetryGate(makeDb({ txs: [tx()] }), ROW, { nowMs: NOW }, { liveEntitlement })).toEqual({ ok: false, reason: 'paid_in_mirror' })
    expect(await un1tRetryGate(makeDb({ ledger: [event({ idempotency_key: LEGACY_KEY })] }), ROW, { nowMs: NOW }, { liveEntitlement })).toEqual({ ok: false, reason: 'legacy_checkout' })
    expect(await un1tRetryGate(makeDb({ fail: { un1t_transactions: true } }), ROW, { nowMs: NOW }, { liveEntitlement })).toMatchObject({ ok: false, reason: 'read_failed' })
    expect(await un1tRetryGate(makeDb(), { ...ROW, status: 'granted' }, { nowMs: NOW }, { liveEntitlement })).toEqual({ ok: false, reason: 'not_retryable' })
    expect(liveEntitlement).not.toHaveBeenCalled()
  })
})

describe('resumeUn1tTrialCheckout — the checkout (a normal cancel: unpaid, nothing on the account)', () => {
  it("hands back the row's own checkout while it is certainly still open, with no write to un1t.online or the row", async () => {
    const db = makeDb({ ledger: [event({ created_at: ago(UN1T_CHECKOUT_REUSE_MS - 1000) })] })
    expect(await run(db)).toEqual({ kind: 'redirect', checkoutUrl: 'https://checkout.stripe.com/c/pay/first', reused: true, attempt: 1 })
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
    // …but only after every paid check has been made.
    expect(db.reads.map((r) => r.table)).toEqual(['trial_purchases', 'un1t_write_events', 'un1t_transactions'])
    expect(liveEntitlement).toHaveBeenCalledTimes(1)
  })

  it('the ledger is read for this row, this account and this product only, newest first', async () => {
    const db = makeDb()
    await run(db)
    expect(db.reads[1].table).toBe('un1t_write_events')
    expect(db.reads[1].filters).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'loc2'], ['eq', 'op', 'checkout'], ['eq', 'origin_ref', ID], ['eq', 'un1t_user_id', 'u-77'], ['eq', 'target', 'prod-1'],
      ['order', 'created_at', { ascending: false }],
    ]))
  })

  it('past that, a FRESH checkout for the same row and account: attempt-scoped key, the paid=1 and cancelled=1 returns, origin web_trial', async () => {
    const db = makeDb({ ledger: [event({ created_at: ago(UN1T_CHECKOUT_REUSE_MS) })] })
    expect(await run(db)).toEqual({ kind: 'redirect', checkoutUrl: 'https://checkout.stripe.com/c/pay/fresh', reused: false, attempt: 2 })
    expect(createLink).toHaveBeenCalledTimes(1)
    expect(createLink).toHaveBeenCalledWith(db, {
      locationId: 'loc2', userId: 'u-77', productId: 'prod-1',
      successUrl: `https://www.un1tdublin.com/hatch-street?purchase=${ID}&studio=hatch&paid=1`,
      cancelUrl: `https://www.un1tdublin.com/hatch-street?purchase=${ID}&studio=hatch&cancelled=1`,
      idempotencyKey: KEY(1),
      origin: 'web_trial', originRef: ID, actor: null,
    })
    // No account is found or made here: the row already names it.
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    // The row points at its newest checkout, and nothing else on it changes.
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].patch).toEqual({ un1t_ledger_id: 'led-2' })
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([['eq', 'id', ID], ['eq', 'location_id', 'loc2'], ['eq', 'status', 'awaiting_payment']]))
  })

  it('each attempt has its own key, counted off the ledger (so the ledger says how many times the row went to pay)', async () => {
    const old = { created_at: ago(5 * 60 * MIN) }
    const three = [event({ id: 'l3', idempotency_key: KEY(2), ...old }), event({ id: 'l2', idempotency_key: KEY(1), stage: 'refused', checkout_url: null, ...old }), event(old)]
    const r = await run(makeDb({ ledger: three }))
    expect(r).toMatchObject({ kind: 'redirect', reused: false, attempt: 4 })
    expect(createLink.mock.calls[0][1].idempotencyKey).toBe(KEY(3))
  })

  it('an attempt still open under its key is resumed under that key, never doubled', async () => {
    for (const stage of ['sent', 'unknown']) {
      createLink.mockClear()
      await run(makeDb({ ledger: [event({ id: 'l2', stage, checkout_url: null, idempotency_key: KEY(1), created_at: ago(2 * MIN) }), event()] }))
      expect(createLink.mock.calls[0][1].idempotencyKey).toBe(KEY(1))
    }
  })

  it('a ledger with no usable checkout (none, or a done row with no URL) makes one', async () => {
    expect(await run(makeDb({ ledger: [] }))).toMatchObject({ kind: 'redirect', reused: false, attempt: 1 })
    expect(createLink.mock.calls[0][1].idempotencyKey).toBe(KEY(0))
    createLink.mockClear()
    expect(await run(makeDb({ ledger: [event({ checkout_url: null, created_at: ago(MIN) })] }))).toMatchObject({ reused: false })
    expect(createLink).toHaveBeenCalledTimes(1)
  })

  it('a refused newest attempt never hands back an older URL as if it were current', async () => {
    const r = await run(makeDb({ ledger: [event({ id: 'l2', stage: 'refused', checkout_url: null, idempotency_key: KEY(1), created_at: ago(MIN) }), event({ created_at: ago(5 * MIN) })] }))
    expect(r).toMatchObject({ kind: 'redirect', reused: false })
  })

  it('defaults the return to /trial', async () => {
    await resumeUn1tTrialCheckout(makeDb({ ledger: [] }), { purchaseId: ID, now: () => NOW }, { createLink, liveEntitlement })
    expect(createLink.mock.calls[0][1].successUrl).toBe(`https://www.un1tdublin.com/trial?purchase=${ID}&studio=hatch&paid=1`)
  })
})

describe('resumeUn1tTrialCheckout — the row is never closed', () => {
  const refusal = (code, retryable) => new Un1tWriteRefused(code, 'x', { verdict: 'refused', code, retryable })

  it.each([
    ['a throttle or budget answer', () => refusal('UN1T_BUDGET', true), { kind: 'unavailable', code: 'UN1T_BUDGET' }],
    ['a hard refusal (the product is gone)', () => refusal('product_not_sellable', false), { kind: 'not_resumable', state: 'refused' }],
    ['an unclear answer', () => new Un1tWriteUnknown('outcome_unknown', 'x'), { kind: 'unavailable', code: 'outcome_unknown' }],
    ['an unreadable switch', () => new Un1tSettingsReadError('x', { code: 'mirror_read_failed' }), { kind: 'unavailable', code: 'mirror_read_failed' }],
    ['anything else thrown', () => new Error('boom'), { kind: 'unavailable', code: 'checkout_error' }],
  ])('%s leaves the row exactly as it was (an earlier checkout may still be paid)', async (_n, make, expected) => {
    const db = stale()
    createLink.mockRejectedValueOnce(make())
    expect(await run(db)).toEqual(expected)
    expect(db.updates).toHaveLength(0)
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('an unreadable customer site is unavailable and sends nothing', async () => {
    const db = stale()
    mocks.baseUrl.mockRejectedValueOnce(new Error('no host'))
    expect(await run(db)).toEqual({ kind: 'unavailable', code: 'checkout_error' })
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })

  it('a free answer or one with no page to pay on is unavailable, never a redirect', async () => {
    for (const answer of [{ checkoutUrl: 'https://x', free: true, ledgerId: 'l' }, { checkoutUrl: '', free: false }, { free: false }, null]) {
      const db = stale()
      createLink.mockResolvedValueOnce(answer)
      expect(await run(db)).toEqual({ kind: 'unavailable', code: 'checkout_no_url' })
      expect(db.updates).toHaveLength(0)
    }
  })

  it('a ledger link whose write FAILED is a warn line: the buyer still goes to pay', async () => {
    const db = stale({ fail: { update: true } })
    expect(await run(db)).toMatchObject({ kind: 'redirect', reused: false })
    expect(mocks.warn).toHaveBeenCalledWith('trialbuy-resume', 'un1t ledger id not stamped', expect.objectContaining({ purchaseId: ID, ledgerId: 'led-2' }))
  })

  it('no log line ever carries a checkout URL', async () => {
    const db = stale()
    createLink.mockRejectedValueOnce(refusal('product_not_sellable', false))
    await run(db)
    await run(stale({ fail: { update: true } }))
    await run(stale({ txs: [tx()] }))
    await run(stale({ stampHits: 0 }))
    expect(JSON.stringify([...mocks.warn.mock.calls, ...mocks.error.mock.calls])).not.toContain('checkout.stripe.com')
  })
})
