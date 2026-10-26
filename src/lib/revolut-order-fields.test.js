// REVPAY.7 — what createOrder sends for customer, merchant_order_data.reference,
// statement_descriptor_suffix and expire_pending_after, against the limits in
// merchant-2026-03-12 (Order-Creation-v6), and that the payments adapter
// threads the new arguments through.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOrder, DEFAULT_EXPIRE_PENDING_AFTER } from './revolut'
import { createPayment } from './payments/revolut'
import {
  isoDurationFromSeconds,
  isoDurationFromHours,
  normaliseExpirePendingAfter,
  sanitiseStatementDescriptorSuffix,
  buildCustomer,
} from './revolut-order-fields'

let fetchMock
beforeEach(() => {
  vi.stubEnv('REVOLUT_API_KEY', 'sk_test')
  vi.stubEnv('REVOLUT_API_BASE_URL', 'https://rev.test')
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ord_1', token: 't', state: 'pending' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body)

describe('createOrder body mapping', () => {
  it('maps every new argument to the spec field name', async () => {
    await createOrder({
      amount: 5000,
      customer: { email: 'a@b.ie', fullName: 'Aoife Byrne', phone: '+353871234567' },
      merchantReference: 'race:reg-1',
      statementDescriptorSuffix: 'DEPOSIT',
      expirePendingAfter: 'PT2H',
    })
    expect(sentBody()).toEqual({
      amount: 5000,
      currency: 'EUR',
      customer: { email: 'a@b.ie', full_name: 'Aoife Byrne', phone: '+353871234567' },
      merchant_order_data: { reference: 'race:reg-1' },
      statement_descriptor_suffix: 'DEPOSIT',
      expire_pending_after: 'PT2H',
    })
  })

  it('omits every optional field that is not given, except the 30-minute default expiry', async () => {
    await createOrder({ amount: 1000 })
    expect(sentBody()).toEqual({ amount: 1000, currency: 'EUR', expire_pending_after: 'PT30M' })
    expect(DEFAULT_EXPIRE_PENDING_AFTER).toBe('PT30M')
  })

  it('expirePendingAfter: null opts out: the field is not sent', async () => {
    await createOrder({ amount: 1000, expirePendingAfter: null })
    expect('expire_pending_after' in sentBody()).toBe(false)
  })

  it('an unparseable expiry is dropped, not thrown', async () => {
    await createOrder({ amount: 1000, expirePendingAfter: 'half an hour' })
    expect('expire_pending_after' in sentBody()).toBe(false)
  })

  it('an invalid email is not sent but the name still is; nothing valid means no customer object', async () => {
    await createOrder({ amount: 1000, customer: { email: 'not-an-email', fullName: 'Aoife' } })
    expect(sentBody().customer).toEqual({ full_name: 'Aoife' })
    fetchMock.mockClear()
    await createOrder({ amount: 1000, customer: { email: 'nope', fullName: '   ', phone: '0871234567' } })
    expect('customer' in sentBody()).toBe(false)
  })

  it('a blank reference or a suffix with nothing sendable in it is omitted', async () => {
    await createOrder({ amount: 1000, merchantReference: '  ', statementDescriptorSuffix: '***' })
    const b = sentBody()
    expect('merchant_order_data' in b).toBe(false)
    expect('statement_descriptor_suffix' in b).toBe(false)
  })
})

describe('sanitiseStatementDescriptorSuffix', () => {
  it('upper-cases, strips accents, and drops the characters the spec forbids (* \\n \\r \\)', () => {
    expect(sanitiseStatementDescriptorSuffix('Café*Bar\\ one\r\ntwo')).toBe('CAFE BAR ONE TWO')
  })
  it('truncates to 19 characters and trims what the cut leaves', () => {
    const out = sanitiseStatementDescriptorSuffix('UN1T Stillorgan Intro Class')
    expect(out).toBe('UN1T STILLORGAN INT')
    expect(out.length).toBeLessThanOrEqual(19)
    expect(sanitiseStatementDescriptorSuffix('ABCDEFGHIJKLMNOPQR STUV')).toBe('ABCDEFGHIJKLMNOPQR')
  })
  it('replaces an em dash and emoji, and returns null when nothing is left', () => {
    expect(sanitiseStatementDescriptorSuffix('Race — Entry')).toBe('RACE ENTRY')
    expect(sanitiseStatementDescriptorSuffix('***')).toBeNull()
    expect(sanitiseStatementDescriptorSuffix(null)).toBeNull()
    expect(sanitiseStatementDescriptorSuffix('')).toBeNull()
  })
})

describe('expiry helpers', () => {
  it('formats and clamps to PT1M..PT720H', () => {
    expect(isoDurationFromSeconds(1800)).toBe('PT30M')
    expect(isoDurationFromSeconds(3600)).toBe('PT1H')
    expect(isoDurationFromSeconds(3599)).toBe('PT1H')
    expect(isoDurationFromSeconds(5400)).toBe('PT1H30M')
    expect(isoDurationFromSeconds(5)).toBe('PT1M')
    expect(isoDurationFromSeconds(999 * 86400)).toBe('PT720H')
    expect(isoDurationFromHours(48)).toBe('PT48H')
    expect(isoDurationFromHours(9999)).toBe('PT720H')
  })
  it('normalises a caller-supplied ISO 8601 duration, clamping the range and refusing nonsense', () => {
    expect(normaliseExpirePendingAfter('P7D')).toBe('PT168H')
    expect(normaliseExpirePendingAfter('pt15m')).toBe('PT15M')
    expect(normaliseExpirePendingAfter('PT10S')).toBe('PT1M')
    expect(normaliseExpirePendingAfter('P60D')).toBe('PT720H')
    for (const bad of ['', 'P', 'PT', '-PT5M', 'PT-5M', '30 minutes', 'P1W', 30, null, undefined]) {
      expect(normaliseExpirePendingAfter(bad)).toBeNull()
    }
  })
})

describe('buildCustomer', () => {
  it('trims, collapses whitespace in the name, and accepts only an E.164 phone', () => {
    expect(buildCustomer({ email: ' a@b.ie ', fullName: '  Aoife   Byrne ', phone: '+353 87 123 4567' }))
      .toEqual({ email: 'a@b.ie', full_name: 'Aoife Byrne', phone: '+353871234567' })
    expect(buildCustomer({ phone: '087 123 4567' })).toBeNull()
  })
  it('never sends a customer id', () => {
    expect(buildCustomer({ id: 'abc', email: 'a@b.ie' })).toEqual({ email: 'a@b.ie' })
  })
})

describe('payments adapter (revolut)', () => {
  it('threads the new arguments through to createOrder', async () => {
    const res = await createPayment({
      amountCents: 2500, currency: 'EUR', description: 'x', returnUrl: 'https://r/x', metadata: { a: 1 }, idempotencyKey: 'k',
      customer: { email: 'a@b.ie', fullName: 'A B' }, merchantReference: 'donation:d1', statementDescriptorSuffix: 'DONATION', expirePendingAfter: 'PT48H',
    })
    expect(res.providerRef).toBe('ord_1')
    expect(sentBody()).toMatchObject({
      amount: 2500,
      customer: { email: 'a@b.ie', full_name: 'A B' },
      merchant_order_data: { reference: 'donation:d1' },
      statement_descriptor_suffix: 'DONATION',
      expire_pending_after: 'PT48H',
    })
  })
  it('an adapter call that passes none of them still gets the default expiry', async () => {
    await createPayment({ amountCents: 2500, currency: 'EUR' })
    expect(sentBody().expire_pending_after).toBe('PT30M')
    expect('customer' in sentBody()).toBe(false)
  })
})
