import { describe, it, expect } from 'vitest'
import client from '../../tests/fixtures/un1t-online/client.json'
import product from '../../tests/fixtures/un1t-online/product.json'
import subscription from '../../tests/fixtures/un1t-online/subscription.json'
import transaction from '../../tests/fixtures/un1t-online/transaction.json'
import invoice from '../../tests/fixtures/un1t-online/invoice.json'
import event from '../../tests/fixtures/un1t-online/event.json'
import booking from '../../tests/fixtures/un1t-online/booking.json'
import {
  mapClient, contactFieldsFromClient, mapProduct, mapSubscription, mapTransaction,
  mapInvoice, mapEvent, mapBooking, rowStudioId, MEMBERSHIP_ACTIVE_STATUSES,
} from './un1t-online-map.js'

const ctx = { locationId: 'loc-1', now: '2026-10-16T12:00:00.000Z' }
const clone = (o) => JSON.parse(JSON.stringify(o))

describe('mapClient', () => {
  it('never carries reset or next-of-kin fields', () => {
    const s = JSON.stringify(mapClient(client, ctx))
    expect(s).not.toContain('reset_password')
    expect(s).not.toContain('next_of_kin')
    expect(s).not.toContain('"abc"')
    expect(s).not.toContain('abc')
  })

  it('flattens ledger, 30-day counts and ltv', () => {
    const r = mapClient(client, ctx)
    expect(r).toMatchObject({
      location_id: 'loc-1',
      un1t_user_id: client.id,
      status: 'active',
      credit_balance: 3,
      credit_unlimited: false,
      bookings_30d_attended: 4,
      bookings_30d_no_show: 1,
      ltv_cents: 18900,
      last_attended_at: client.last_attended_at,
      remote_created_at: client.created_at,
      remote_updated_at: client.updated_at,
      synced_at: ctx.now,
    })
    expect(r).not.toHaveProperty('raw')
    expect(r).not.toHaveProperty('email')
  })

  it('tolerates missing ledger, counts and ltv, and returns null without an id', () => {
    const r = mapClient({ id: 'x' }, ctx)
    expect(r.credit_balance).toBeNull()
    expect(r.bookings_30d_attended).toBeNull()
    expect(r.ltv_cents).toBeNull()
    expect(mapClient({}, ctx)).toBeNull()
    expect(mapClient(null, ctx)).toBeNull()
  })
})

describe('contactFieldsFromClient', () => {
  it('lowercases and trims email', () => {
    expect(contactFieldsFromClient({ ...client, email: '  Jane@X.ie ' }).email).toBe('jane@x.ie')
    expect(contactFieldsFromClient(client).email).toBe('test.person@example.ie')
  })
  it('returns null email for empty or invalid', () => {
    expect(contactFieldsFromClient({ ...client, email: '' }).email).toBeNull()
    expect(contactFieldsFromClient({ ...client, email: '   ' }).email).toBeNull()
    expect(contactFieldsFromClient({ ...client, email: undefined }).email).toBeNull()
  })
  it('normalises phone and names', () => {
    const f = contactFieldsFromClient(client)
    expect(f.phone).toBe('+353851234567')
    expect(f.first_name).toBe('Test')
    expect(f.last_name).toBe('Person')
    expect(Object.keys(f).sort()).toEqual(['email', 'first_name', 'last_name', 'phone'])
  })
})

describe('raw hygiene', () => {
  const cases = [
    ['subscription', mapSubscription, subscription],
    ['transaction', mapTransaction, transaction],
    ['invoice', mapInvoice, invoice],
    ['booking', mapBooking, booking],
  ]
  for (const [name, fn, row] of cases) {
    it(`${name} raw never holds an embedded user, guest PII or invoice_url`, () => {
      const r = fn(row, ctx)
      expect(r.raw.user).toBeUndefined()
      expect(r.raw.guest_name).toBeUndefined()
      expect(r.raw.guest_email).toBeUndefined()
      expect(r.raw.guest_phone).toBeUndefined()
      expect(r.raw.invoice_url).toBeUndefined()
      expect(r.un1t_user_id).toBe(row.user_id)
      const s = JSON.stringify(r)
      expect(s).not.toContain('guest@example.ie')
      expect(s).not.toContain('secret-link')
      expect(s).not.toContain('test.person@example.ie')
    })
  }

  for (const [name, fn, row] of cases) {
    it(`${name} reads the user id from the embed when user_id is absent`, () => {
      const embedOnly = { ...row, user_id: undefined, user: { id: 'u-embed', email: 'test.person@example.ie' } }
      const r = fn(embedOnly, ctx)
      expect(r.un1t_user_id).toBe('u-embed')
      expect(JSON.stringify(r)).not.toContain('test.person@example.ie')
      // A flat user_id still wins.
      expect(fn({ ...embedOnly, user_id: 'u-flat' }, ctx).un1t_user_id).toBe('u-flat')
    })
  }

  it('raw keeps the non-PII fields', () => {
    expect(mapInvoice(invoice, ctx).raw.stripe_invoice_id).toBe('in_test')
    expect(mapBooking(booking, ctx).raw.source).toBe('app')
  })

  it('strips reset/next-of-kin keys from any raw if they ever appear', () => {
    const r = mapProduct({ ...product, reset_password_token: 'zzz', next_of_kin: { a: 1 } }, ctx)
    expect(JSON.stringify(r)).not.toContain('zzz')
    expect(r.raw.next_of_kin).toBeUndefined()
  })

  it('does not mutate the input row', () => {
    const b = clone(booking)
    mapBooking(b, ctx)
    expect(b).toEqual(booking)
  })
})

describe('mapBooking', () => {
  it('sets has_guest', () => {
    expect(mapBooking(booking, ctx).has_guest).toBe(true)
    expect(mapBooking({ ...booking, guest_name: null, guest_email: '', guest_phone: undefined }, ctx).has_guest).toBe(false)
    expect(mapBooking({ ...booking, guest_name: null, guest_email: null, guest_phone: '0850000001' }, ctx).has_guest).toBe(true)
  })
  it('maps the scalar columns', () => {
    expect(mapBooking(booking, ctx)).toMatchObject({
      location_id: 'loc-1', un1t_id: booking.id, event_id: booking.event_id,
      status: 'booked', source: 'app', credit_charged: true,
      external_member_ref: null, external_booking_ref: null,
      remote_created_at: booking.created_at, remote_updated_at: booking.updated_at,
      synced_at: ctx.now,
    })
  })
})

describe('money', () => {
  it('stays integer cents', () => {
    const t = mapTransaction(transaction, ctx)
    expect(t.amount_cents).toBe(18900)
    expect(t).toMatchObject({
      product_id: transaction.product_id, product_title: 'Test Unlimited',
      invoice_id: transaction.invoice_id, type: 'payment', product_type: 'subscription',
      currency: 'eur', refunded: false, refund_status: 'none',
      remote_created_at: transaction.created_at,
    })
    const s = mapSubscription(subscription, ctx)
    expect(s.price_cents).toBe(8900)
    expect(s.product_title).toBe('Test Unlimited')
    expect(s).toMatchObject({
      currency: 'eur', billing_interval: 'month', billing_interval_count: 1,
      credits_per_period: 12, status: 'active', cancel_at_period_end: false,
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      trial_end: null, paused_at: null, paused_until: null, past_due_at: null,
    })
  })
  it('rounds a non-integer amount rather than storing a fraction', () => {
    expect(mapTransaction({ ...transaction, amount: 18900.4 }, ctx).amount_cents).toBe(18900)
  })
  it('maps products and invoices', () => {
    expect(mapProduct(product, ctx)).toMatchObject({
      un1t_id: product.id, title: 'Test Unlimited', type: 'subscription', status: 'active',
      visibility: 'public', price_cents: 8900, currency: 'eur', billing_interval: 'month',
      billing_interval_count: 1, credits_per_period: 12,
    })
    expect(mapInvoice(invoice, ctx)).toMatchObject({
      un1t_id: invoice.id, subscription_id: invoice.subscription_id,
      status: 'paid', amount_cents: 8900, currency: 'eur', remote_created_at: invoice.created_at,
    })
  })
})

describe('mapEvent', () => {
  it('maps capacity and times', () => {
    const e = mapEvent(event, ctx)
    expect(e).toMatchObject({
      un1t_id: event.id, title: 'Test Class', status: 'scheduled', access_mode: 'members',
      is_free: false, capacity: 12, bookings_count: 7, series_id: event.series_id,
      starts_at: event.start_time, ends_at: event.end_time,
    })
    expect(e.raw.id).toBe(event.id)
  })
})

describe('column parity and ids', () => {
  it('returns null for a row missing id', () => {
    for (const fn of [mapProduct, mapSubscription, mapTransaction, mapInvoice, mapEvent, mapBooking]) {
      expect(fn({}, ctx)).toBeNull()
      expect(fn(null, ctx)).toBeNull()
    }
  })
  it('outputs exactly the table columns minus id and contact_id', () => {
    const keys = (o) => Object.keys(o).sort()
    expect(keys(mapClient(client, ctx))).toEqual(['bookings_30d_attended', 'bookings_30d_no_show', 'credit_balance', 'credit_unlimited', 'last_attended_at', 'location_id', 'ltv_cents', 'remote_created_at', 'remote_updated_at', 'status', 'synced_at', 'un1t_user_id'])
    expect(keys(mapProduct(product, ctx))).toEqual(['billing_interval', 'billing_interval_count', 'credits_per_period', 'currency', 'location_id', 'price_cents', 'raw', 'status', 'synced_at', 'title', 'type', 'un1t_id', 'visibility'])
    expect(keys(mapSubscription(subscription, ctx))).toEqual(['billing_interval', 'billing_interval_count', 'cancel_at_period_end', 'credits_per_period', 'currency', 'current_period_end', 'current_period_start', 'location_id', 'past_due_at', 'paused_at', 'paused_until', 'price_cents', 'product_id', 'product_title', 'raw', 'remote_created_at', 'remote_updated_at', 'status', 'synced_at', 'trial_end', 'un1t_id', 'un1t_user_id'])
    expect(keys(mapTransaction(transaction, ctx))).toEqual(['amount_cents', 'currency', 'invoice_id', 'location_id', 'product_id', 'product_title', 'product_type', 'raw', 'refund_status', 'refunded', 'remote_created_at', 'synced_at', 'type', 'un1t_id', 'un1t_user_id'])
    expect(keys(mapInvoice(invoice, ctx))).toEqual(['amount_cents', 'currency', 'location_id', 'raw', 'remote_created_at', 'status', 'subscription_id', 'synced_at', 'un1t_id', 'un1t_user_id'])
    expect(keys(mapEvent(event, ctx))).toEqual(['access_mode', 'bookings_count', 'capacity', 'ends_at', 'is_free', 'location_id', 'raw', 'series_id', 'starts_at', 'status', 'synced_at', 'title', 'un1t_id'])
    expect(keys(mapBooking(booking, ctx))).toEqual(['credit_charged', 'event_id', 'external_booking_ref', 'external_member_ref', 'has_guest', 'location_id', 'raw', 'remote_created_at', 'remote_updated_at', 'source', 'status', 'synced_at', 'un1t_id', 'un1t_user_id'])
  })
})

describe('rowStudioId', () => {
  it('reads studio.id for clients and studio_id for the rest', () => {
    expect(rowStudioId('client', client)).toBe(client.studio.id)
    for (const [k, r] of [['product', product], ['subscription', subscription], ['transaction', transaction], ['invoice', invoice], ['event', event], ['booking', booking]]) {
      expect(rowStudioId(k, r)).toBe(r.studio_id)
    }
  })
  it('returns null when absent', () => {
    expect(rowStudioId('client', { id: 'x' })).toBeNull()
    expect(rowStudioId('booking', {})).toBeNull()
    expect(rowStudioId('booking', null)).toBeNull()
  })
})

describe('MEMBERSHIP_ACTIVE_STATUSES', () => {
  it('is frozen', () => {
    expect(MEMBERSHIP_ACTIVE_STATUSES).toEqual(['active', 'trialing', 'past_due'])
    expect(Object.isFrozen(MEMBERSHIP_ACTIVE_STATUSES)).toBe(true)
  })
})

// UN1THARD.3 — the raw strip reaches every depth, and a transaction drops its
// free-text description.
describe('raw payload stripping at depth', () => {
  const ctx = { locationId: 'loc', now: '2026-10-17T00:00:00.000Z' }

  it('drops a stripped key inside an embedded object and inside array elements', () => {
    const row = mapSubscription({
      id: 's1', user_id: 'u1', status: 'active', studio_id: 'st',
      product: { id: 'p1', title: 'Unlimited', user: { id: 'u1', email: 'x@example.invalid' } },
      history: [{ at: '2026-10-01', guest_email: 'g@example.invalid', next_of_kin: 'K' }],
    }, ctx)
    expect(row.raw.product).toEqual({ id: 'p1', title: 'Unlimited' })
    expect(row.raw.history).toEqual([{ at: '2026-10-01' }])
    expect(JSON.stringify(row.raw)).not.toMatch(/example\.invalid|next_of_kin/)
  })

  it("a transaction's raw drops description; other tables keep theirs", () => {
    const t = mapTransaction({ id: 't1', user_id: 'u1', amount: 100, description: 'Paid for Jane Doe', studio_id: 'st' }, ctx)
    expect(t.raw).not.toHaveProperty('description')
    const p = mapProduct({ id: 'p1', title: 'Unlimited', description: 'All classes', studio_id: 'st' }, ctx)
    expect(p.raw.description).toBe('All classes')
  })

  it('cuts anything nested deeper than the cap instead of copying it unchecked', () => {
    let deep = { leaf: 'x', user: { email: 'deep@example.invalid' } }
    for (let i = 0; i < 10; i++) deep = { child: deep }
    const e = mapEvent({ id: 'e1', studio_id: 'st', extra: deep }, ctx)
    expect(JSON.stringify(e.raw)).not.toContain('deep@example.invalid')
  })
})
