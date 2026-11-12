// BLACKFRIDAY.5 — the Hatch Street offer purchase sweep off the un1t.online
// mirror. un1t.online takes the money on its hosted checkout; this sweep is
// what records each paid Black Friday purchase so staff add the bonus. What it
// pins: an in-window purchase with no page row is recorded off_page once; an
// off-window one is not; a page row created before the window closed is
// honoured when the money lands after it; renewals, refunds and other products
// never count; two runs never record one transaction twice; an abandoned page
// row is cancelled; a failed read writes nothing and answers ok:false.
//
// The fake database is stateful: offer_purchases, un1t_transactions,
// sale_offers, un1t_clients and contacts are arrays the chain's filters run
// against, and an insert/update changes them, so a second run sees the first.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  link: vi.fn(), notify: vi.fn(), tag: vi.fn(), setPassword: vi.fn(), settings: vi.fn(),
  sendAccountEmail: vi.fn(), error: vi.fn(), warn: vi.fn(),
}))
vi.mock('@/lib/sale-offers', () => ({
  OFFER_SALE_TAG: 'offer-sale-bf-2026',
  linkOrCreateContactForPurchase: mocks.link,
  notifyStaffOfPaidPurchase: mocks.notify,
}))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: mocks.tag }))
vi.mock('@/lib/un1t-online-account', () => ({ runSetPasswordStep: mocks.setPassword }))
vi.mock('@/lib/un1t-online-settings', () => ({ readUn1tWriteSettings: mocks.settings }))
vi.mock('@/lib/un1t-online-funnel-emails', () => ({ sendUn1tAccountEmail: mocks.sendAccountEmail }))
vi.mock('@/lib/trial-purchase-un1t-settle', () => ({ UN1T_TRIAL_EXPIRY_MS: 24 * 60 * 60_000 + 45 * 60_000 }))
vi.mock('@/lib/log', () => ({ logError: mocks.error, logWarn: mocks.warn, logInfo: vi.fn() }))

import { sweepUn1tOfferPurchases, OFFER_SET_PASSWORD_BODY, EXPIRED_ERROR } from './un1t-offer-purchases'

const LOC = 'loc-hatch'
const HOUR = 60 * 60_000
const OFFER_3M = {
  id: 'off-3m', location_id: LOC, name: '3 Months Unlimited', bonus_headline: '+1 month free',
  un1t_product_id: 'prod-3m', starts_at: '2026-11-23T00:00:00.000Z', ends_at: '2026-11-30T23:59:59.000Z',
}
const OFFER_TRIAL = { ...OFFER_3M, id: 'off-trial', name: 'Trial pack', un1t_product_id: 'prod-trial' }
const CONTACT = { id: 'c1', name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne', email: 'ava@example.com', phone: '+353851234567' }

const tx = (over = {}) => ({
  location_id: LOC, un1t_id: 'tx1', un1t_user_id: 'u1', contact_id: null, product_id: 'prod-3m', type: 'purchase',
  amount_cents: 19900, currency: 'EUR', refunded: false, refund_status: null,
  remote_created_at: '2026-11-24T10:00:00.000Z', ...over,
})
const pageRow = (over = {}) => ({
  id: 'op1', offer_id: 'off-3m', location_id: LOC, contact_id: 'c1', buyer_name: 'Ava Byrne',
  buyer_email: 'ava@example.com', buyer_phone: '+353851234567', amount_cents: 19900, currency: 'EUR',
  payment_provider: 'un1t_online', origin: 'page', state: 'created', un1t_user_id: 'u1',
  un1t_product_id: 'prod-3m', un1t_transaction_id: null, paid_at: null,
  created_at: '2026-11-24T09:55:00.000Z', ...over,
})

function matches(r, [op, col, val, extra]) {
  if (op === 'eq') return r[col] === val
  if (op === 'gte') return r[col] >= val
  if (op === 'lte') return r[col] <= val
  if (op === 'lt') return r[col] < val
  if (op === 'in') return val.includes(r[col])
  if (op === 'is') return r[col] === val || (val === null && r[col] == null)
  if (op === 'not' && val === 'is' && extra === null) return r[col] != null
  return true
}

function makeDb({ offers = [OFFER_3M], txs = [], purchases = [], clients = [{ location_id: LOC, un1t_user_id: 'u1', contact_id: 'c1' }], contacts = [CONTACT], fail = {} } = {}) {
  const tables = { sale_offers: offers, un1t_transactions: txs, offer_purchases: purchases, un1t_clients: clients, contacts }
  const writes = []
  let nextId = 1
  const db = {
    from: (table) => {
      const filters = []
      const orders = []
      let range = null
      let kind = 'select'
      let payload = null
      let returning = false
      const settle = async (mode) => {
        if (kind === 'update') {
          writes.push({ table, kind, fields: payload, filters: [...filters] })
          const hit = tables[table].filter((r) => filters.every((f) => matches(r, f)))
          if (payload.un1t_transaction_id && tables[table].some((r) => !hit.includes(r)
            && r.location_id === hit[0]?.location_id && r.un1t_transaction_id === payload.un1t_transaction_id)) {
            return { data: null, error: { code: '23505' } }
          }
          for (const r of hit) Object.assign(r, payload)
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null }
        }
        if (kind === 'insert') {
          writes.push({ table, kind, fields: payload })
          if (fail.insert) return { data: null, error: { code: 'XX000' } }
          if (table === 'offer_purchases' && tables[table].some((r) => r.location_id === payload.location_id
            && r.un1t_transaction_id && r.un1t_transaction_id === payload.un1t_transaction_id)) {
            return { data: null, error: { code: '23505' } }
          }
          const rowIn = { id: `new-${nextId++}`, created_at: '2026-12-02T00:00:00.000Z', ...payload }
          tables[table].push(rowIn)
          return { data: returning ? [{ id: rowIn.id }] : null, error: null }
        }
        if (fail[table]) return { data: null, error: { code: 'XX000' } }
        let out = tables[table].filter((r) => filters.every((f) => matches(r, f)))
        for (const [col, asc] of [...orders].reverse()) {
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        if (range) out = out.slice(range[0], range[1] + 1)
        out = out.map((r) => ({ ...r }))
        return { data: mode === 'one' ? out[0] ?? null : out, error: null }
      }
      const b = {
        select: () => { if (kind !== 'select') returning = true; return b },
        update: (p) => { kind = 'update'; payload = p; return b },
        insert: (p) => { kind = 'insert'; payload = p; return b },
        order: (col, { ascending = true } = {}) => { orders.push([col, ascending]); return b },
        range: (a, z) => { range = [a, z]; return b },
        limit: (n) => { range = [0, n - 1]; return b },
        maybeSingle: () => settle('one'),
        then: (res, rej) => settle('many').then(res, rej),
      }
      for (const op of ['eq', 'gte', 'lte', 'lt', 'in', 'is', 'not']) b[op] = (...args) => { filters.push([op, ...args]); return b }
      return b
    },
  }
  return { db, writes, tables }
}

const purchaseWrites = (writes) => writes.filter((w) => w.table === 'offer_purchases')
const NOW = () => Date.parse('2026-12-02T09:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.link.mockResolvedValue({ contactId: 'c1' })
  mocks.notify.mockResolvedValue({ sent: true })
  mocks.tag.mockResolvedValue({ written: true })
  mocks.settings.mockResolvedValue({ membershipSource: 'un1t_online', settings: { writesEnabled: true } })
  mocks.setPassword.mockResolvedValue({ explanation: 'sent', forgotPassword: 'done' })
})

describe('sweepUn1tOfferPurchases', () => {
  it('sweep records off-page purchase in window', async () => {
    const { db, writes, tables } = makeDb({ txs: [tx()] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, checked: 1, recorded: 1, matchedPage: 0, failed: 0, passwordPending: 0 })
    const inserts = purchaseWrites(writes).filter((w) => w.kind === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].fields).toMatchObject({
      origin: 'off_page', state: 'paid', payment_provider: 'un1t_online', un1t_transaction_id: 'tx1',
      un1t_user_id: 'u1', un1t_product_id: 'prod-3m', offer_id: 'off-3m', location_id: LOC,
      amount_cents: 19900, paid_at: '2026-11-24T10:00:00.000Z', contact_id: 'c1',
      buyer_name: 'Ava Byrne', buyer_email: 'ava@example.com', buyer_phone: '+353851234567',
    })
    expect(tables.offer_purchases).toHaveLength(1)
    expect(mocks.tag).toHaveBeenCalledWith(db, expect.objectContaining({ contactId: 'c1', locationId: LOC, tag: 'offer-sale-bf-2026' }))
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({ id: 'off-3m' })
    // Off-page rows never run the set-password step.
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('an off-page buyer with no linked contact is recorded under the fallback name', async () => {
    const { db, writes } = makeDb({ txs: [tx()], clients: [] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, recorded: 1 })
    const ins = purchaseWrites(writes).find((w) => w.kind === 'insert')
    expect(ins.fields).toMatchObject({ buyer_name: 'un1t.online client', buyer_email: '', buyer_phone: '', contact_id: null })
    expect(mocks.tag).not.toHaveBeenCalled()
  })

  it('sweep ignores off-window off-page transactions', async () => {
    const { db, writes } = makeDb({
      txs: [tx({ un1t_id: 'tx-early', remote_created_at: '2026-11-22T10:00:00.000Z' }), tx({ un1t_id: 'tx-late', remote_created_at: '2026-12-01T10:00:00.000Z' })],
    })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, recorded: 0, matchedPage: 0 })
    expect(purchaseWrites(writes).filter((w) => w.kind === 'insert')).toHaveLength(0)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('sweep honours late payment for a page row', async () => {
    const page = pageRow({ created_at: '2026-11-30T23:50:00.000Z' })
    const { db, writes, tables } = makeDb({
      purchases: [page],
      txs: [tx({ remote_created_at: '2026-12-01T00:30:00.000Z' })],
    })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: () => Date.parse('2026-12-01T01:00:00.000Z') })
    expect(r).toMatchObject({ ok: true, matchedPage: 1, recorded: 0, failed: 0, passwordPending: 0 })
    const upd = purchaseWrites(writes).filter((w) => w.kind === 'update' && w.fields.state === 'paid')
    expect(upd).toHaveLength(1)
    expect(upd[0].filters).toContainEqual(['eq', 'id', 'op1'])
    expect(upd[0].filters).toContainEqual(['eq', 'state', 'created'])
    expect(upd[0].fields).toMatchObject({ paid_at: '2026-12-01T00:30:00.000Z', un1t_transaction_id: 'tx1', amount_cents: 19900 })
    expect(tables.offer_purchases[0].state).toBe('paid')
    expect(purchaseWrites(writes).filter((w) => w.kind === 'insert')).toHaveLength(0)
    expect(mocks.link).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
    const [, args, deps] = mocks.setPassword.mock.calls[0]
    expect(args).toMatchObject({
      locationId: LOC, un1tUserId: 'u1', origin: 'web_offer', contact: expect.objectContaining({ id: 'c1' }),
      emailArgs: { kind: 'trial_purchase', productName: '3 Months Unlimited', copy: { subject: 'Your UN1T Hatch Street account', body: OFFER_SET_PASSWORD_BODY } },
    })
    expect(deps).toEqual({ sendUn1tAccountEmail: mocks.sendAccountEmail })
    expect(OFFER_SET_PASSWORD_BODY).toBe("Thanks for your Black Friday purchase at UN1T Hatch Street. We've set up your un1t.online account. Check your inbox for a code to set your password, then book your first class in the app.")
  })

  it('a page row created after the window closed is not honoured', async () => {
    const page = pageRow({ created_at: '2026-12-01T00:10:00.000Z' })
    const { db, writes } = makeDb({ purchases: [page], txs: [tx({ remote_created_at: '2026-12-01T00:30:00.000Z' })] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: () => Date.parse('2026-12-01T01:00:00.000Z') })
    expect(r).toMatchObject({ matchedPage: 0, recorded: 0 })
    expect(purchaseWrites(writes)).toHaveLength(0)
  })

  it('fix 1: a late payment settles a page row the sweep had already expired, and set-password runs', async () => {
    const expired = pageRow({ created_at: '2026-11-30T23:50:00.000Z', state: 'cancelled', last_error: EXPIRED_ERROR })
    const { db, writes, tables } = makeDb({ purchases: [expired], txs: [tx({ remote_created_at: '2026-12-01T00:30:00.000Z' })] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: () => Date.parse('2026-12-03T09:00:00.000Z') })
    expect(r).toMatchObject({ ok: true, matchedPage: 1, recorded: 0, failed: 0, passwordPending: 0 })
    const upd = purchaseWrites(writes).find((w) => w.kind === 'update' && w.fields.state === 'paid')
    expect(upd.filters).toContainEqual(['eq', 'state', 'cancelled'])
    expect(upd.fields).toMatchObject({ last_error: null, updated_at: '2026-12-03T09:00:00.000Z' })
    expect(tables.offer_purchases[0]).toMatchObject({ state: 'paid', last_error: null, un1t_transaction_id: 'tx1' })
    expect(purchaseWrites(writes).filter((w) => w.kind === 'insert')).toHaveLength(0)
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('fix 1: an in-window payment on an expired page row settles that row, not an off_page insert', async () => {
    const expired = pageRow({ state: 'cancelled', last_error: EXPIRED_ERROR })
    const { db, writes, tables } = makeDb({ purchases: [expired], txs: [tx()] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, matchedPage: 1, recorded: 0 })
    expect(tables.offer_purchases).toHaveLength(1)
    expect(tables.offer_purchases[0].state).toBe('paid')
    expect(purchaseWrites(writes).filter((w) => w.kind === 'insert')).toHaveLength(0)
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
  })

  it('fix 1: a page row cancelled for another reason is never re-opened', async () => {
    const cancelled = pageRow({ state: 'cancelled', last_error: 'buyer_cancelled' })
    const { db, writes, tables } = makeDb({ purchases: [cancelled], txs: [tx()] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, matchedPage: 0, recorded: 1 })
    expect(tables.offer_purchases.find((p) => p.id === 'op1')).toMatchObject({ state: 'cancelled', last_error: 'buyer_cancelled' })
    expect(purchaseWrites(writes).filter((w) => w.kind === 'update' && w.filters.some((f) => f[1] === 'id' && f[2] === 'op1'))).toHaveLength(0)
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('fix 1: an expired row is not expired again', async () => {
    const expired = pageRow({ state: 'cancelled', last_error: EXPIRED_ERROR, created_at: '2026-11-01T00:00:00.000Z' })
    const { db, writes } = makeDb({ purchases: [expired] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, expired: 0 })
    expect(purchaseWrites(writes)).toHaveLength(0)
  })

  it('minor 1: a set-password step that did not finish counts in passwordPending, not failed, and is stamped', async () => {
    mocks.setPassword.mockResolvedValueOnce({ explanation: 'deferred', forgotPassword: 'in_doubt' })
    const { db, tables } = makeDb({ purchases: [pageRow()], txs: [tx()] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, matchedPage: 1, failed: 0, passwordPending: 1 })
    expect(tables.offer_purchases[0]).toMatchObject({ state: 'paid', last_error: 'set_password:in_doubt' })
    mocks.setPassword.mockRejectedValueOnce(new Error('ledger down'))
    const b = makeDb({ purchases: [pageRow()], txs: [tx()] })
    const r2 = await sweepUn1tOfferPurchases(b.db, LOC, { now: NOW })
    expect(r2).toMatchObject({ ok: true, failed: 0, passwordPending: 1 })
    expect(b.tables.offer_purchases[0].last_error).toBe('set_password:error')
  })

  it('minor 3: the window end is inclusive to the end of its second', async () => {
    const { db, writes } = makeDb({ txs: [tx({ remote_created_at: '2026-11-30T23:59:59.500Z' })] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, recorded: 1 })
    expect(purchaseWrites(writes).find((w) => w.kind === 'insert').fields.origin).toBe('off_page')
    const after = makeDb({ txs: [tx({ remote_created_at: '2026-12-01T00:00:00.000Z' })] })
    expect((await sweepUn1tOfferPurchases(after.db, LOC, { now: NOW })).recorded).toBe(0)
  })

  it('sweep is idempotent across runs', async () => {
    const { db, tables } = makeDb({ txs: [tx()] })
    const a = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    const b = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(a.recorded).toBe(1)
    expect(b).toMatchObject({ ok: true, recorded: 0, failed: 0 })
    expect(tables.offer_purchases).toHaveLength(1)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('a page row settled in one run is not re-settled or re-recorded in the next', async () => {
    const { db, tables } = makeDb({ purchases: [pageRow()], txs: [tx()] })
    const a = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    const b = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(a.matchedPage).toBe(1)
    expect(b).toMatchObject({ matchedPage: 0, recorded: 0 })
    expect(tables.offer_purchases).toHaveLength(1)
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
  })

  it('a 23505 on the transaction key counts as already recorded, not failed', async () => {
    // An overlapping run recorded the transaction between this run's used read and its insert.
    const raced = makeDb({ txs: [tx()] })
    const realFrom = raced.db.from
    raced.db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'offer_purchases') return b
      const realInsert = b.insert
      b.insert = (p) => { raced.tables.offer_purchases.push({ id: 'other', location_id: LOC, un1t_transaction_id: p.un1t_transaction_id }); return realInsert(p) }
      return b
    }
    const r = await sweepUn1tOfferPurchases(raced.db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, recorded: 0, failed: 0 })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('sweep skips renewals and refunds', async () => {
    const { db, writes } = makeDb({
      txs: [tx({ un1t_id: 'r1', type: 'sub_renewal' }), tx({ un1t_id: 'r2', refunded: true }), tx({ un1t_id: 'r3', amount_cents: 0 })],
    })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, checked: 0, recorded: 0 })
    expect(purchaseWrites(writes)).toHaveLength(0)
  })

  it('sweep never matches a different product', async () => {
    const { db, writes, tables } = makeDb({
      offers: [OFFER_3M, OFFER_TRIAL],
      purchases: [pageRow()],
      txs: [tx({ product_id: 'prod-trial' })],
    })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: () => Date.parse('2026-11-24T11:00:00.000Z') })
    expect(r).toMatchObject({ matchedPage: 0, recorded: 1 })
    expect(tables.offer_purchases.find((p) => p.id === 'op1').state).toBe('created')
    const ins = purchaseWrites(writes).find((w) => w.kind === 'insert')
    expect(ins.fields).toMatchObject({ offer_id: 'off-trial', un1t_product_id: 'prod-trial', origin: 'off_page' })
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('sweep expires stale page rows', async () => {
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z')
    const stale = pageRow({ id: 'op-stale', created_at: new Date(nowMs - 26 * HOUR).toISOString() })
    const fresh = pageRow({ id: 'op-fresh', un1t_user_id: 'u2', created_at: new Date(nowMs - 2 * HOUR).toISOString() })
    const { db, writes, tables } = makeDb({ purchases: [stale, fresh] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: () => nowMs })
    expect(r).toMatchObject({ ok: true, expired: 1 })
    expect(tables.offer_purchases.find((p) => p.id === 'op-stale').state).toBe('cancelled')
    expect(tables.offer_purchases.find((p) => p.id === 'op-fresh').state).toBe('created')
    const upd = purchaseWrites(writes).find((w) => w.fields.state === 'cancelled')
    expect(upd.filters).toContainEqual(['eq', 'state', 'created'])
  })

  it('sweep read failure is not ok', async () => {
    const { db, writes } = makeDb({ txs: [tx()], purchases: [pageRow({ created_at: '2026-11-01T00:00:00.000Z' })], fail: { un1t_transactions: true } })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('an offer read failure or a used-ids read failure is not ok either', async () => {
    for (const table of ['sale_offers', 'offer_purchases']) {
      const { db, writes } = makeDb({ txs: [tx()], fail: { [table]: true } })
      const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
      expect(r.ok).toBe(false)
      expect(writes).toHaveLength(0)
    }
  })

  it('no offer with a un1t.online product: ok and nothing read further', async () => {
    const { db, writes } = makeDb({ offers: [{ ...OFFER_3M, un1t_product_id: null }], txs: [tx()] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, checked: 0, recorded: 0 })
    expect(writes).toHaveLength(0)
  })

  it('a failed side effect counts as failed and the run carries on', async () => {
    mocks.notify.mockRejectedValueOnce(new Error('postmark down'))
    const { db } = makeDb({ txs: [tx(), tx({ un1t_id: 'tx2', un1t_user_id: 'u9' })] })
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r).toMatchObject({ ok: true, recorded: 2, failed: 1 })
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    // Logs carry ids and codes only, never the buyer's email or phone.
    for (const call of [...mocks.error.mock.calls, ...mocks.warn.mock.calls]) {
      expect(JSON.stringify(call)).not.toMatch(/ava@example\.com|\+353851234567/)
    }
  })

  it('never throws', async () => {
    const db = { from: () => { throw new Error('boom') } }
    const r = await sweepUn1tOfferPurchases(db, LOC, { now: NOW })
    expect(r.ok).toBe(false)
  })
})
