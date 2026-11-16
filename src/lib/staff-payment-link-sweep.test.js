// PAYLINK.1 — the sweep that marks staff payment links paid off the
// un1t_transactions mirror.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ step: vi.fn(), settings: vi.fn(), email: vi.fn() }))
vi.mock('@/lib/un1t-online-account', () => ({ runSetPasswordStep: mocks.step }))
vi.mock('@/lib/un1t-online-settings', () => ({ readUn1tWriteSettings: mocks.settings }))
vi.mock('@/lib/un1t-online-funnel-emails', () => ({ sendUn1tAccountEmail: mocks.email }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { sweepStaffPaymentLinks, PAYLINK_SET_PASSWORD_SUBJECT, PAYLINK_SET_PASSWORD_BODY } from './staff-payment-link-sweep'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

// A tiny in-memory PostgREST stand-in: select/update with eq/in/gte/not/order/range.
function makeDb(tables, { failRead = null, failUpdate = false, lostCas = new Set(), dupPaid = false } = {}) {
  const log = { updates: [] }
  const from = (name) => {
    const q = { op: 'select', filters: [], patch: null, ord: [] }
    const b = {}
    b.select = () => b
    b.update = (p) => { q.op = 'update'; q.patch = p; return b }
    b.eq = (c, v) => { q.filters.push((r) => r[c] === v); return b }
    b.in = (c, vs) => { q.filters.push((r) => vs.includes(r[c])); return b }
    b.gte = (c, v) => { q.filters.push((r) => r[c] >= v); return b }
    b.or = () => b
    b.not = (c, _o, v) => { q.filters.push((r) => r[c] !== v); return b }
    b.order = (c) => { q.ord.push(c); return b }
    b.range = (from_, to) => { q.range = [from_, to]; return b }
    b.maybeSingle = () => { q.one = true; return b }
    b.then = (res, rej) => {
      if (failRead === name && q.op === 'select') return Promise.resolve({ data: null, error: { code: 'XX' } }).then(res, rej)
      let rows = (tables[name] || []).filter((r) => q.filters.every((f) => f(r)))
      if (q.op === 'update') {
        if (dupPaid && q.patch.status === 'paid') return Promise.resolve({ data: null, error: { code: '23505' } }).then(res, rej)
        if (failUpdate) return Promise.resolve({ data: null, error: { code: 'XX' } }).then(res, rej)
        rows = rows.filter((r) => !lostCas.has(r.id))
        rows.forEach((r) => Object.assign(r, q.patch))
        log.updates.push({ name, patch: q.patch, ids: rows.map((r) => r.id) })
        return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res, rej)
      }
      for (const c of [...q.ord].reverse()) rows = [...rows].sort((a, z) => String(a[c]).localeCompare(String(z[c])))
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1)
      if (q.one) return Promise.resolve({ data: rows[0] || null, error: null }).then(res, rej)
      return Promise.resolve({ data: rows, error: null }).then(res, rej)
    }
    return b
  }
  return { from, log }
}

const link = (o = {}) => ({
  id: 'L1', location_id: 'loc', contact_id: 'c1', status: 'sent', un1t_user_id: 'u1', un1t_product_id: 'p1',
  product_title: 'Starter pack', created_at: iso(NOW - 2 * DAY), expires_at: iso(NOW + 5 * DAY),
  terms_accepted_at: null, last_error: null, paid_transaction_id: null, paid_at: null, ...o,
})
const tx = (o = {}) => ({
  un1t_id: 't1', location_id: 'loc', un1t_user_id: 'u1', product_id: 'p1', type: 'one_off', amount_cents: 12500,
  refunded: false, remote_created_at: iso(NOW - DAY), ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue({ settings: {} })
  mocks.step.mockResolvedValue({ forgotPassword: 'done' })
})

describe('sweepStaffPaymentLinks', () => {
  it('marks a link paid on a matching transaction (CAS on the status as read)', async () => {
    const t = { staff_payment_links: [link({ status: 'checkout_started' })], un1t_transactions: [tx()], contacts: [] }
    const db = makeDb(t)
    const res = await sweepStaffPaymentLinks(db, 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, paid: 1, failed: 0 })
    expect(t.staff_payment_links[0]).toMatchObject({ status: 'paid', paid_transaction_id: 't1', paid_at: tx().remote_created_at })
  })

  it('ignores a renewal, another product and a transaction before the link', async () => {
    const t = { staff_payment_links: [link()], un1t_transactions: [
      tx({ un1t_id: 'a', type: 'sub_renewal' }), tx({ un1t_id: 'b', product_id: 'other' }),
      tx({ un1t_id: 'c', remote_created_at: iso(NOW - 5 * DAY) }), tx({ un1t_id: 'd', refunded: true }),
    ] }
    const res = await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    expect(res.paid).toBe(0)
    expect(t.staff_payment_links[0].status).toBe('sent')
  })

  it('one transaction never pays two links; the oldest link wins', async () => {
    const t = { staff_payment_links: [
      link({ id: 'new', created_at: iso(NOW - 3 * DAY), contact_id: 'c2' }),
      link({ id: 'old', created_at: iso(NOW - 4 * DAY) }),
    ], un1t_transactions: [tx()] }
    const res = await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    expect(res.paid).toBe(1)
    expect(t.staff_payment_links.find((l) => l.id === 'old').status).toBe('paid')
    expect(t.staff_payment_links.find((l) => l.id === 'new').status).toBe('sent')
  })

  it('a late-mirrored payment settles a recently expired link, never a revoked one or a free one', async () => {
    const t = { staff_payment_links: [
      link({ id: 'exp', status: 'expired', expires_at: iso(NOW - DAY) }),
      link({ id: 'rev', status: 'revoked', un1t_user_id: 'u1' }),
      link({ id: 'free', un1t_user_id: 'u3', last_error: 'checkout_free' }),
      link({ id: 'old', status: 'expired', un1t_user_id: 'u4', expires_at: iso(NOW - 4 * DAY) }),
    ], un1t_transactions: [tx(), tx({ un1t_id: 'f', un1t_user_id: 'u3' }), tx({ un1t_id: 'g', un1t_user_id: 'u4' })] }
    const res = await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    const st = (id) => t.staff_payment_links.find((l) => l.id === id).status
    expect(res.paid).toBe(1)
    expect([st('exp'), st('rev'), st('free'), st('old')]).toEqual(['paid', 'revoked', 'sent', 'expired'])
  })

  it('expires a live link past expires_at with no payment (CAS), and counts a lost CAS as raced, not failed', async () => {
    const t = { staff_payment_links: [link({ id: 'a', expires_at: iso(NOW - 1000) }), link({ id: 'b', un1t_user_id: 'u2', expires_at: iso(NOW - 1000) })], un1t_transactions: [] }
    const res = await sweepStaffPaymentLinks(makeDb(t, { lostCas: new Set(['b']) }), 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, expired: 1, failed: 0 })
    expect(t.staff_payment_links[0].status).toBe('expired')
    expect(t.staff_payment_links[1].status).toBe('sent')
  })

  it('a lost paid CAS is raced: no set-password, not failed', async () => {
    const t = { staff_payment_links: [link({ terms_accepted_at: iso(NOW) })], un1t_transactions: [tx()] }
    const res = await sweepStaffPaymentLinks(makeDb(t, { lostCas: new Set(['L1']) }), 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, paid: 0, failed: 0 })
    expect(mocks.step).not.toHaveBeenCalled()
  })

  it('a read error is ok:false and writes nothing', async () => {
    for (const failRead of ['staff_payment_links', 'un1t_transactions']) {
      const t = { staff_payment_links: [link({ expires_at: iso(NOW - 1000) })], un1t_transactions: [tx()] }
      const db = makeDb(t, { failRead })
      const res = await sweepStaffPaymentLinks(db, 'loc', { now: NOW })
      expect(res.ok).toBe(false)
      expect(db.log.updates).toEqual([])
    }
  })

  it('a failed write is counted in failed', async () => {
    const t = { staff_payment_links: [link()], un1t_transactions: [tx()] }
    const res = await sweepStaffPaymentLinks(makeDb(t, { failUpdate: true }), 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, paid: 0, failed: 1 })
  })

  it('runs the set-password step only for a CRM-created account (terms_accepted_at set)', async () => {
    const mk = (terms) => ({ staff_payment_links: [link({ terms_accepted_at: terms })], un1t_transactions: [tx()], contacts: [{ id: 'c1', email: 'a@b.c' }] })
    await sweepStaffPaymentLinks(makeDb(mk(null)), 'loc', { now: NOW })
    expect(mocks.step).not.toHaveBeenCalled()
    await sweepStaffPaymentLinks(makeDb(mk(iso(NOW - DAY))), 'loc', { now: NOW })
    expect(mocks.step).toHaveBeenCalledTimes(1)
    const [, args, deps] = mocks.step.mock.calls[0]
    expect(args).toMatchObject({ locationId: 'loc', un1tUserId: 'u1', origin: 'staff_payment_link',
      emailArgs: { copy: { subject: PAYLINK_SET_PASSWORD_SUBJECT, body: PAYLINK_SET_PASSWORD_BODY } } })
    expect(PAYLINK_SET_PASSWORD_SUBJECT).toBe('Your UN1T Hatch Street account')
    expect(deps).toEqual({ sendUn1tAccountEmail: mocks.email })
  })

  it('a set-password failure is counted in passwordPending and noted on the row', async () => {
    mocks.step.mockResolvedValue({ forgotPassword: 'failed_5xx' })
    const t = { staff_payment_links: [link({ terms_accepted_at: iso(NOW - DAY) })], un1t_transactions: [tx()], contacts: [{ id: 'c1', email: 'a@b.c' }] }
    const res = await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, paid: 1, passwordPending: 1, failed: 0 })
    expect(t.staff_payment_links[0]).toMatchObject({ status: 'paid', last_error: 'set_password:failed_5xx' })
  })

  it('a live link is offered the payment before a recently expired one', async () => {
    const t = { staff_payment_links: [
      link({ id: 'exp', status: 'expired', created_at: iso(NOW - 6 * DAY), expires_at: iso(NOW - DAY) }),
      link({ id: 'live', created_at: iso(NOW - 3 * DAY) }),
    ], un1t_transactions: [tx()] }
    await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    const st = (id) => t.staff_payment_links.find((l) => l.id === id).status
    expect([st('live'), st('exp')]).toEqual(['paid', 'expired'])
  })

  it('a transaction already on a paid row settles no other link in a later run', async () => {
    const t = { staff_payment_links: [
      link({ id: 'done', status: 'paid', paid_transaction_id: 't1' }),
      link({ id: 'next', contact_id: 'c2' }),
    ], un1t_transactions: [tx()] }
    const res = await sweepStaffPaymentLinks(makeDb(t), 'loc', { now: NOW })
    expect(res.paid).toBe(0)
    expect(t.staff_payment_links[1].status).toBe('sent')
  })

  it('a unique violation on the paid write is raced: no set-password, not failed', async () => {
    const t = { staff_payment_links: [link({ terms_accepted_at: iso(NOW) })], un1t_transactions: [tx()], contacts: [{ id: 'c1' }] }
    const res = await sweepStaffPaymentLinks(makeDb(t, { dupPaid: true }), 'loc', { now: NOW })
    expect(res).toMatchObject({ ok: true, paid: 0, raced: 1, failed: 0 })
    expect(mocks.step).not.toHaveBeenCalled()
  })
})
