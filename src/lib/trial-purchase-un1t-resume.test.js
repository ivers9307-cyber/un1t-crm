// HATCHTRACK.1 — "Continue to payment" for a Hatch Street trial: the same row
// goes back to payment. What it pins: only an unpaid Hatch row that carries
// its un1t.online account; the row's own recent checkout is handed back with
// no write; otherwise a fresh checkout for the SAME row and account under an
// attempt-scoped key; the row's status is never changed, whatever un1t.online
// answers; no account is made, nothing is charged or granted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const mocks = vi.hoisted(() => ({ baseUrl: vi.fn(), ensureAccount: vi.fn(), alert: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.baseUrl }))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: mocks.ensureAccount }))
vi.mock('@/lib/trial-purchase-processor', () => ({ alertTrialPurchaseStaff: mocks.alert }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: vi.fn(() => { throw new Error('the real primitive must be injected in this test') }) }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.warn, logError: mocks.error, logInfo: vi.fn() }))

import { resumeUn1tTrialCheckout } from './trial-purchase-un1t-resume'
import { UN1T_CHECKOUT_REUSE_MS, UN1T_TRIAL_RESUME_MAX_AGE_MS } from './trial-checkout-window'

const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const ID = '11111111-1111-4111-8111-111111111111'
const ROW = {
  id: ID, location_id: 'loc2', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'un1t_online',
  un1t_user_id: 'u-77', un1t_product_id: 'prod-1', created_at: ago(30 * MIN),
}
const event = (over = {}) => ({ id: 'led-1', stage: 'done', checkout_url: 'https://checkout.stripe.com/c/pay/first', idempotency_key: `trial_purchase:${ID}`, created_at: ago(30 * MIN), ...over })

function makeDb({ row = ROW, ledger = [event()], fail = {} } = {}) {
  const reads = []
  const updates = []
  const db = {
    reads, updates,
    from: (table) => {
      const filters = []
      let patch = null
      const settle = async () => {
        if (patch) {
          updates.push({ table, patch, filters: [...filters] })
          return { data: null, error: fail.update ? { code: 'XX000' } : null }
        }
        reads.push({ table, filters: [...filters] })
        if (fail[table]) return { data: null, error: { code: 'XX000' } }
        return { data: table === 'trial_purchases' ? row : ledger, error: null }
      }
      const b = {
        select: () => b,
        update: (p) => { patch = p; return b },
        maybeSingle: () => settle(),
        then: (res, rej) => settle().then(res, rej),
      }
      for (const op of ['eq', 'order', 'range']) b[op] = (...args) => { filters.push([op, ...args]); return b }
      return b
    },
  }
  return db
}

const createLink = vi.fn()
const run = (db, over = {}) => resumeUn1tTrialCheckout(db, { purchaseId: ID, returnPath: '/hatch-street', now: () => NOW, ...over }, { createLink })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.baseUrl.mockResolvedValue('https://www.un1tdublin.com')
  createLink.mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/c/pay/fresh', free: false, ledgerId: 'led-2' })
})

describe('resumeUn1tTrialCheckout — which rows', () => {
  it('an unknown purchase is not_found; an unreadable one is unavailable; neither writes anything', async () => {
    const none = makeDb({ row: null })
    expect(await run(none)).toEqual({ kind: 'not_found' })
    const down = makeDb({ fail: { trial_purchases: true } })
    expect(await run(down)).toEqual({ kind: 'unavailable', code: 'row_unreadable' })
    expect(createLink).not.toHaveBeenCalled()
    expect([...none.updates, ...down.updates]).toHaveLength(0)
  })

  it('reads the row by its id alone, naming no column that holds the buyer', async () => {
    const db = makeDb()
    const cols = []
    const from = db.from
    db.from = (t) => { const b = from(t); const sel = b.select; b.select = (c) => { cols.push([t, c]); return sel() }; return b }
    await run(db)
    expect(db.reads[0]).toEqual({ table: 'trial_purchases', filters: [['eq', 'id', ID]] })
    const rowCols = cols.find(([t]) => t === 'trial_purchases')[1].split(',').map((c) => c.trim())
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
  ])('%s is not_resumable: no ledger read, no checkout, no write', async (_n, over, state) => {
    const db = makeDb({ row: { ...ROW, ...over } })
    expect(await run(db)).toEqual({ kind: 'not_resumable', state })
    expect(db.reads).toHaveLength(1)
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })
})

describe('resumeUn1tTrialCheckout — the checkout', () => {
  it("hands back the row's own checkout while it is certainly still open, with no write to un1t.online or the row", async () => {
    const db = makeDb({ ledger: [event({ created_at: ago(UN1T_CHECKOUT_REUSE_MS - 1000) })] })
    expect(await run(db)).toEqual({ kind: 'redirect', checkoutUrl: 'https://checkout.stripe.com/c/pay/first', reused: true, attempt: 1 })
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
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
      idempotencyKey: `trial_purchase:${ID}:r1`,
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
    const three = [event({ id: 'l3', idempotency_key: `trial_purchase:${ID}:r2`, ...old }), event({ id: 'l2', idempotency_key: `trial_purchase:${ID}:r1`, stage: 'refused', checkout_url: null, ...old }), event(old)]
    const r = await run(makeDb({ ledger: three }))
    expect(r).toMatchObject({ kind: 'redirect', reused: false, attempt: 4 })
    expect(createLink.mock.calls[0][1].idempotencyKey).toBe(`trial_purchase:${ID}:r3`)
  })

  it('an attempt still open under its key is resumed under that key, never doubled', async () => {
    for (const stage of ['sent', 'unknown']) {
      createLink.mockClear()
      await run(makeDb({ ledger: [event({ id: 'l2', stage, checkout_url: null, idempotency_key: `trial_purchase:${ID}:r1`, created_at: ago(2 * MIN) }), event()] }))
      expect(createLink.mock.calls[0][1].idempotencyKey).toBe(`trial_purchase:${ID}:r1`)
    }
  })

  it('a ledger with no usable checkout (none, or a done row with no URL) makes one', async () => {
    expect(await run(makeDb({ ledger: [] }))).toMatchObject({ kind: 'redirect', reused: false, attempt: 1 })
    expect(createLink.mock.calls[0][1].idempotencyKey).toBe(`trial_purchase:${ID}:r0`)
    createLink.mockClear()
    expect(await run(makeDb({ ledger: [event({ checkout_url: null, created_at: ago(MIN) })] }))).toMatchObject({ reused: false })
    expect(createLink).toHaveBeenCalledTimes(1)
  })

  it('a refused newest attempt never hands back an older URL as if it were current', async () => {
    const r = await run(makeDb({ ledger: [event({ id: 'l2', stage: 'refused', checkout_url: null, created_at: ago(MIN) }), event({ created_at: ago(5 * MIN) })] }))
    expect(r).toMatchObject({ kind: 'redirect', reused: false })
  })

  it('defaults the return to /trial', async () => {
    await resumeUn1tTrialCheckout(makeDb({ ledger: [] }), { purchaseId: ID, now: () => NOW }, { createLink })
    expect(createLink.mock.calls[0][1].successUrl).toBe(`https://www.un1tdublin.com/trial?purchase=${ID}&studio=hatch&paid=1`)
  })
})

describe('resumeUn1tTrialCheckout — the row is never closed', () => {
  const stale = () => makeDb({ ledger: [event({ created_at: ago(60 * MIN) })] })
  const refusal = (code, retryable) => new Un1tWriteRefused(code, 'x', { verdict: 'refused', code, retryable })

  it('an unreadable ledger is unavailable: no checkout, no write', async () => {
    const db = makeDb({ fail: { un1t_write_events: true } })
    expect(await run(db)).toEqual({ kind: 'unavailable', code: 'ledger_unreadable' })
    expect(createLink).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })

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

  it('a ledger link that cannot be written is a warn line: the buyer still goes to pay', async () => {
    const db = makeDb({ ledger: [event({ created_at: ago(60 * MIN) })], fail: { update: true } })
    expect(await run(db)).toMatchObject({ kind: 'redirect', reused: false })
    expect(mocks.warn).toHaveBeenCalledWith('trialbuy-resume', 'un1t ledger id not stamped', expect.objectContaining({ purchaseId: ID, ledgerId: 'led-2' }))
  })

  it('no log line ever carries a checkout URL', async () => {
    const db = stale()
    createLink.mockRejectedValueOnce(refusal('product_not_sellable', false))
    await run(db)
    await run(makeDb({ ledger: [event({ created_at: ago(60 * MIN) })], fail: { update: true } }))
    expect(JSON.stringify([...mocks.warn.mock.calls, ...mocks.error.mock.calls])).not.toContain('checkout.stripe.com')
  })
})
