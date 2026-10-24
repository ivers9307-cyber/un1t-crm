// TRIALSTUDIO.7 — the Hatch Street settlement sweeper. un1t.online takes the
// money; the CRM learns of it from the un1t_transactions mirror. What it pins:
// a purchase dated after the row settles it (Purchase once, set-password once);
// an older, renewal or €0 transaction does not; one purchase settles AT MOST
// one row (product match, then the newest), never twice across sweeps; an
// abandoned row expires after 24h45m; a guard that matched nothing (raced)
// sends nothing.
//
// The fake database is stateful: trial_purchases and un1t_transactions are
// arrays the chain's filters run against, and an update under its guards
// changes the row, so a second sweep sees what the first one wrote.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ capi: vi.fn(), setPassword: vi.fn(), settings: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi }))
vi.mock('@/lib/un1t-online-account', () => ({ runSetPasswordStep: mocks.setPassword }))
vi.mock('@/lib/un1t-online-settings', () => ({ readUn1tWriteSettings: mocks.settings }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: mocks.warn, logInfo: vi.fn() }))

import { settleUn1tTrialPurchases, UN1T_TRIAL_EXPIRY_MS } from './trial-purchase-un1t-settle'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const CONTACT = { id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Byrne', name: 'Ava Byrne' }
const SETTINGS = { writesEnabled: true, sendsWelcome: false, welcomeSetsLogin: false }

const row = (over = {}) => ({
  id: 'tp1', location_id: 'loc2', contact_id: 'c1', status: 'awaiting_payment', payment_provider: 'un1t_online',
  payment_status: null, payment_provider_ref: null, un1t_user_id: 'u1', un1t_product_id: 'prodP',
  product_name: 'The UN1T Trial', amount_cents: 3900, currency: 'EUR',
  customer_email: 'ava@example.com', customer_phone: '+353851234567', first_name: 'Ava', last_name: 'Byrne',
  attribution: { fbc: 'fb.1.x', fbp: 'fb.1.y', event_source_url: 'https://www.un1tdublin.com/trial' },
  created_at: iso(T0), ...over,
})
const tx = (over = {}) => ({
  location_id: 'loc2', un1t_id: 'tx1', un1t_user_id: 'u1', product_id: 'prodP', type: 'purchase',
  amount_cents: 3900, remote_created_at: iso(T0 + 5 * MIN), ...over,
})

function matches(r, [op, col, val, extra]) {
  if (op === 'eq') return r[col] === val
  if (op === 'gte') return r[col] >= val
  if (op === 'in') return val.includes(r[col])
  if (op === 'not' && val === 'is' && extra === null) return r[col] != null
  return true
}

function makeDb({ rows = [], txs = [], contact = CONTACT, race = new Set(), fail = {} } = {}) {
  const tables = { trial_purchases: rows, un1t_transactions: txs }
  const updates = []
  const reads = []
  const db = {
    from: (table) => {
      const filters = []
      const orders = []
      let range = null
      let kind = 'select'
      let patch = null
      let returning = false
      const settle = async (mode) => {
        if (kind === 'update') {
          updates.push({ table, fields: patch, filters: [...filters] })
          if (fail.update) return { data: null, error: { code: 'XX000' } }
          if (fail.settleCode && patch.status === 'granted') return { data: null, error: { code: fail.settleCode } }
          const hit = tables[table].filter((r) => {
            if (race.has(r.id)) r.status = 'help_requested' // someone else got there first
            return filters.every((f) => matches(r, f))
          })
          for (const r of hit) Object.assign(r, patch)
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null }
        }
        reads.push({ table, filters: [...filters] })
        if (fail[table]) return { data: null, error: { code: 'XX000' } }
        if (table === 'contacts') return { data: contact, error: null }
        let out = tables[table].filter((r) => filters.every((f) => matches(r, f)))
        for (const [col, asc] of [...orders].reverse()) {
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        if (range) out = out.slice(range[0], range[1] + 1)
        out = out.map((r) => ({ ...r }))
        return { data: mode === 'one' ? out[0] ?? null : out, error: null }
      }
      const b = {
        select: () => { if (kind === 'update') returning = true; return b },
        update: (p) => { kind = 'update'; patch = p; return b },
        order: (col, { ascending = true } = {}) => { orders.push([col, ascending]); return b },
        range: (a, z) => { range = [a, z]; return b },
        maybeSingle: () => settle('one'),
        then: (res, rej) => settle('many').then(res, rej),
      }
      for (const op of ['eq', 'gte', 'in', 'not']) b[op] = (...args) => { filters.push([op, ...args]); return b }
      return b
    },
  }
  return { db, updates, reads, rows }
}

const trialUpdates = (updates) => updates.filter((u) => u.table === 'trial_purchases')
const guardedBy = (u, id) => {
  expect(u.filters).toContainEqual(['eq', 'id', id])
  expect(u.filters).toContainEqual(['eq', 'status', 'awaiting_payment'])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capi.mockResolvedValue({ sent: true })
  mocks.setPassword.mockResolvedValue({ explanation: 'sent', forgotPassword: 'done' })
  mocks.settings.mockResolvedValue({ membershipSource: 'un1t_online', settings: SETTINGS })
})

describe('settleUn1tTrialPurchases', () => {
  it('UN1T_TRIAL_EXPIRY_MS is 24h45m', () => {
    expect(UN1T_TRIAL_EXPIRY_MS).toBe(24 * 60 * 60_000 + 45 * 60_000)
  })

  it('settles a row off a matching transaction dated after it, sends Purchase once, runs the set-password step', async () => {
    const { db, updates, rows } = makeDb({ rows: [row()], txs: [tx()] })
    const now = () => T0 + 10 * MIN
    const r = await settleUn1tTrialPurchases(db, { now })
    expect(r).toMatchObject({ settled: 1, expired: 0, errors: 0 })

    const [u] = trialUpdates(updates)
    expect(u.fields).toEqual({
      status: 'granted', granted_at: tx().remote_created_at, payment_status: 'paid', paid_at: tx().remote_created_at,
      payment_provider_ref: 'tx1', grant: { ok: true, method: 'un1t_checkout', transaction: 'tx1', at: iso(T0 + 10 * MIN) },
    })
    guardedBy(u, 'tp1')

    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(db, {
      locationId: 'loc2', eventName: 'Purchase',
      email: 'ava@example.com', phone: '+353851234567', firstName: 'Ava', lastName: 'Byrne',
      externalId: 'c1', eventSourceUrl: 'https://www.un1tdublin.com/trial',
      eventId: 'trialpurchase-tp1', contentName: 'The UN1T Trial',
      value: 39, currency: 'EUR', orderId: 'tp1', contentType: 'product',
      fbc: 'fb.1.x', fbp: 'fb.1.y',
    })
    expect(mocks.settings).toHaveBeenCalledWith(db, 'loc2')
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
    expect(mocks.setPassword).toHaveBeenCalledWith(db, {
      locationId: 'loc2', contact: CONTACT, un1tUserId: 'u1', request: null,
      settings: SETTINGS, origin: 'web_trial', emailArgs: {}, writer: null,
    })
    expect(rows[0].status).toBe('granted')

    // The next sweep (or a re-run after a crash) finds nothing open: no second Purchase.
    const again = await settleUn1tTrialPurchases(db, { now })
    expect(again).toMatchObject({ settled: 0, expired: 0, errors: 0 })
    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.setPassword).toHaveBeenCalledTimes(1)
  })

  it('an older transaction does not settle', async () => {
    const { db, updates } = makeDb({ rows: [row()], txs: [tx({ remote_created_at: iso(T0 - MIN) })] })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toMatchObject({ settled: 0, expired: 0, errors: 0 })
    expect(trialUpdates(updates)).toEqual([])
    expect(mocks.capi).not.toHaveBeenCalled()
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('a sub_renewal or €0 transaction does not settle', async () => {
    const { db, updates } = makeDb({
      rows: [row()],
      txs: [tx({ un1t_id: 'txR', type: 'sub_renewal' }), tx({ un1t_id: 'tx0', amount_cents: 0 })],
    })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toMatchObject({ settled: 0, expired: 0, errors: 0 })
    expect(trialUpdates(updates)).toEqual([])
    expect(mocks.capi).not.toHaveBeenCalled()
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('expires a row 24h45m old with no transaction; leaves a 24h old one', async () => {
    const now = T0 + 2 * 24 * 60 * MIN
    const { db, updates, rows } = makeDb({
      rows: [
        row({ id: 'old', created_at: iso(now - UN1T_TRIAL_EXPIRY_MS - 1000) }),
        row({ id: 'noUser', un1t_user_id: null, created_at: iso(now - UN1T_TRIAL_EXPIRY_MS - 1000) }),
        row({ id: 'young', created_at: iso(now - 24 * 60 * MIN) }),
      ],
    })
    const r = await settleUn1tTrialPurchases(db, { now: () => now })
    expect(r).toMatchObject({ settled: 0, expired: 2, errors: 0 })
    const ups = trialUpdates(updates)
    expect(ups).toHaveLength(2)
    for (const [u, id] of [[ups[0], 'old'], [ups[1], 'noUser']]) {
      expect(u.fields).toEqual({ status: 'expired' })
      guardedBy(u, id)
    }
    expect(rows.map((x) => [x.id, x.status])).toEqual([['old', 'expired'], ['noUser', 'expired'], ['young', 'awaiting_payment']])
    expect(mocks.capi).not.toHaveBeenCalled()
  })

  it('a status guard that matches nothing (raced) sends no Purchase', async () => {
    const { db, updates } = makeDb({ rows: [row()], txs: [tx()], race: new Set(['tp1']) })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toMatchObject({ settled: 0, expired: 0 })
    expect(trialUpdates(updates)).toHaveLength(1)
    guardedBy(trialUpdates(updates)[0], 'tp1')
    expect(mocks.capi).not.toHaveBeenCalled()
    expect(mocks.setPassword).not.toHaveBeenCalled()
  })

  it('one payment settles exactly one of two open rows (product match, then newest)', async () => {
    // Same product on both: the NEWEST row takes the payment.
    {
      const { db, updates, rows } = makeDb({
        rows: [row({ id: 'older' }), row({ id: 'newer', created_at: iso(T0 + MIN) })],
        txs: [tx()],
      })
      const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
      expect(r).toMatchObject({ settled: 1, expired: 0, errors: 0 })
      expect(trialUpdates(updates)).toHaveLength(1)
      guardedBy(trialUpdates(updates)[0], 'newer')
      expect(rows.map((x) => [x.id, x.status])).toEqual([['older', 'awaiting_payment'], ['newer', 'granted']])
      expect(mocks.capi).toHaveBeenCalledTimes(1)
      expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({ eventId: 'trialpurchase-newer' }))
      expect(mocks.setPassword).toHaveBeenCalledTimes(1)
    }
    vi.clearAllMocks()
    mocks.settings.mockResolvedValue({ settings: SETTINGS })
    // The older row sold the product that was bought: the product match wins over newest.
    {
      const { db, rows } = makeDb({
        rows: [row({ id: 'older' }), row({ id: 'newer', un1t_product_id: 'prodQ', created_at: iso(T0 + MIN) })],
        txs: [tx()],
      })
      const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
      expect(r).toMatchObject({ settled: 1 })
      expect(rows.map((x) => [x.id, x.status])).toEqual([['older', 'granted'], ['newer', 'awaiting_payment']])
      expect(mocks.capi).toHaveBeenCalledTimes(1)
      expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({ eventId: 'trialpurchase-older' }))

      // The other row stays open, never takes the same payment, and expires on time.
      const later = T0 + UN1T_TRIAL_EXPIRY_MS + MIN
      const r2 = await settleUn1tTrialPurchases(db, { now: () => later })
      expect(r2).toMatchObject({ settled: 0, expired: 0 })
      const r3 = await settleUn1tTrialPurchases(db, { now: () => later + 2 * MIN })
      expect(r3).toMatchObject({ settled: 0, expired: 1 })
      expect(rows.map((x) => [x.id, x.status])).toEqual([['older', 'granted'], ['newer', 'expired']])
      expect(mocks.capi).toHaveBeenCalledTimes(1)
    }
  })

  it('a transaction already referenced by a row\'s payment_provider_ref is never used again', async () => {
    const { db, updates, reads } = makeDb({
      rows: [
        row({ id: 'done', status: 'granted', payment_status: 'paid', payment_provider_ref: 'tx1', granted_at: tx().remote_created_at, created_at: iso(T0 - 2 * MIN) }),
        row({ id: 'open' }),
      ],
      txs: [tx()],
    })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toMatchObject({ settled: 0, expired: 0, errors: 0 })
    expect(trialUpdates(updates)).toEqual([])
    expect(mocks.capi).not.toHaveBeenCalled()
    expect(mocks.setPassword).not.toHaveBeenCalled()
    // One read of the used references per sweep, scoped to the location.
    const refReads = reads.filter((x) => x.table === 'trial_purchases' && x.filters.some((f) => f[0] === 'not'))
    expect(refReads).toHaveLength(1)
    expect(refReads[0].filters).toContainEqual(['in', 'location_id', ['loc2']])
  })

  it('an unreadable open-row list is a read failure; a failed side effect is an error, never thrown', async () => {
    const failed = makeDb({ rows: [row()], txs: [tx()], fail: { trial_purchases: true } })
    expect(await settleUn1tTrialPurchases(failed.db, { now: () => T0 + 10 * MIN })).toEqual({ settled: 0, expired: 0, errors: 1, raceLost: 0, passwordPending: 0, readFailed: true })

    mocks.capi.mockRejectedValue(new Error('meta down'))
    mocks.setPassword.mockRejectedValue(new Error('ledger down'))
    const { db, rows } = makeDb({ rows: [row()], txs: [tx()] })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toEqual({ settled: 1, expired: 0, errors: 2, raceLost: 0, passwordPending: 1, readFailed: false })
    expect(rows[0].status).toBe('granted')
    expect(rows[0].grant).toMatchObject({ ok: true, transaction: 'tx1', set_password: 'error' })
  })

  it('an unreadable transaction list neither settles nor expires the row', async () => {
    const now = T0 + UN1T_TRIAL_EXPIRY_MS + MIN
    const { db, updates } = makeDb({ rows: [row()], txs: [tx()], fail: { un1t_transactions: true } })
    const r = await settleUn1tTrialPurchases(db, { now: () => now })
    expect(r).toEqual({ settled: 0, expired: 0, errors: 1, raceLost: 0, passwordPending: 0, readFailed: false })
    expect(trialUpdates(updates)).toEqual([])
  })

  it('a set-password step that did not finish is logged, counted and recorded on the row', async () => {
    mocks.setPassword.mockResolvedValue({ explanation: 'deferred', forgotPassword: 'retry', code: 'UN1T_BUDGET' })
    const { db, updates, rows } = makeDb({ rows: [row()], txs: [tx()] })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toMatchObject({ settled: 1, errors: 0, passwordPending: 1 })
    expect(mocks.warn).toHaveBeenCalledWith('trial-purchase-un1t', 'set-password step did not complete', {
      purchaseId: 'tp1', locationId: 'loc2', un1tUserId: 'u1', forgotPassword: 'retry', explanation: 'deferred', code: 'UN1T_BUDGET',
    })
    const [, note] = trialUpdates(updates)
    expect(note.fields).toEqual({ grant: { ok: true, method: 'un1t_checkout', transaction: 'tx1', at: iso(T0 + 10 * MIN), set_password: 'retry' } })
    expect(note.filters).toEqual([['eq', 'id', 'tp1']]) // the id only: the row is already granted
    expect(rows[0].status).toBe('granted')
    expect(rows[0].grant.set_password).toBe('retry')

    for (const forgotPassword of ['refused', 'in_doubt']) {
      mocks.setPassword.mockResolvedValue({ explanation: 'sent', forgotPassword })
      const again = makeDb({ rows: [row()], txs: [tx()] })
      expect(await settleUn1tTrialPurchases(again.db, { now: () => T0 + 10 * MIN })).toMatchObject({ passwordPending: 1 })
      expect(again.rows[0].grant.set_password).toBe(forgotPassword)
    }
  })

  it('a done or skipped set-password step records nothing more', async () => {
    for (const forgotPassword of ['done', 'skipped_not_created', 'skipped_already_done', 'skipped_flag']) {
      mocks.setPassword.mockResolvedValue({ explanation: 'sent', forgotPassword })
      const { db, updates, rows } = makeDb({ rows: [row()], txs: [tx()] })
      expect(await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })).toMatchObject({ settled: 1, passwordPending: 0 })
      expect(trialUpdates(updates)).toHaveLength(1)
      expect(rows[0].grant.set_password).toBeUndefined()
    }
    expect(mocks.warn).not.toHaveBeenCalledWith('trial-purchase-un1t', 'set-password step did not complete', expect.anything())
  })

  it('a 23505 on the settle stamp is a lost race: no error, nothing sent, the row left for the next sweep', async () => {
    const fail = { settleCode: '23505' }
    const { db, rows } = makeDb({ rows: [row({ id: 'open' })], txs: [tx()], fail })
    const r = await settleUn1tTrialPurchases(db, { now: () => T0 + 10 * MIN })
    expect(r).toEqual({ settled: 0, expired: 0, errors: 0, raceLost: 1, passwordPending: 0, readFailed: false })
    expect(mocks.warn).toHaveBeenCalledWith('trial-purchase-un1t', expect.any(String), expect.objectContaining({ purchaseId: 'open', transaction: 'tx1', code: '23505' }))
    expect(mocks.capi).not.toHaveBeenCalled()
    expect(mocks.setPassword).not.toHaveBeenCalled()
    expect(rows[0].status).toBe('awaiting_payment')

    // The overlapping sweep's row holds the payment: the next sweep leaves it alone.
    delete fail.settleCode
    rows.push(row({ id: 'winner', status: 'granted', payment_status: 'paid', payment_provider_ref: 'tx1', granted_at: tx().remote_created_at, created_at: iso(T0 + MIN) }))
    const next = await settleUn1tTrialPurchases(db, { now: () => T0 + 12 * MIN })
    expect(next).toMatchObject({ settled: 0, raceLost: 0, errors: 0 })
    expect(rows[0].status).toBe('awaiting_payment')
    expect(mocks.capi).not.toHaveBeenCalled()
  })
})
