// BLACKFRIDAY.4 — startUn1tOfferCheckout: the Hatch Street leg of the offer
// checkout. Every un1t.online answer lands the offer_purchases row in exactly
// one judged state; nothing here can charge (only ensureUn1tAccount and
// createCheckoutLink are called, both mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const mocks = vi.hoisted(() => ({
  ensureAccount: vi.fn(), checkout: vi.fn(), alert: vi.fn(),
  inserted: vi.fn(), updated: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
}))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: mocks.ensureAccount }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: mocks.checkout }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: async () => 'https://un1t-group.repset.ie' }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: mocks.alert }))
vi.mock('@/lib/log', () => ({ logError: mocks.logError, logWarn: mocks.logWarn, logInfo: vi.fn() }))

import { startUn1tOfferCheckout } from './offer-checkout-un1t'

const db = {
  from: (table) => ({
    insert: (row) => Promise.resolve(mocks.inserted(table, row)).then((r) => r ?? { error: null }),
    update: (patch) => {
      const filters = []
      const c = {
        eq: (col, v) => { filters.push([col, v]); return c },
        then: (res, rej) => Promise.resolve(mocks.updated(table, patch, filters)).then((r) => r ?? { error: null }).then(res, rej),
      }
      return c
    },
  }),
}

const OFFER = { id: 'offer-h1', location_id: 'loc-h', slug: '3-month-membership', name: '3 Month Membership', price_cents: 59700, currency: 'EUR', un1t_product_id: 'prod-3m', category: 'membership' }
const LOCATION = { id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org1' }
const CONTACT = { id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Doe', name: 'Ava Doe', phone: '0871234567', un1t_user_id: null }
const TERMS = { terms_accepted_at: '2026-11-23T10:00:00.000Z', terms_source: 'website', terms_version: 'v3' }
const BUYER = { name: 'Ava Doe', email: 'ava@example.com', phone: '0871234567' }
const ARGS = { offer: OFFER, location: LOCATION, contact: CONTACT, purchaseId: 'op-1', terms: TERMS, buyer: BUYER }
const patches = () => mocks.updated.mock.calls.map(([, patch]) => {
  const { updated_at: _updatedAt, ...rest } = patch
  return rest
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c1' })
  mocks.checkout.mockResolvedValue({ checkoutUrl: 'https://pay.un1t.online/s/x', free: false, ledgerId: 'led-1' })
  mocks.inserted.mockResolvedValue({ error: null })
  mocks.updated.mockResolvedValue({ error: null })
  mocks.alert.mockResolvedValue({ channel: 'email' })
})

describe('startUn1tOfferCheckout', () => {
  it('inserts the un1t_online row, stamps the user, and returns the hosted checkout', async () => {
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'redirect', checkoutUrl: 'https://pay.un1t.online/s/x' })
    const [table, row] = mocks.inserted.mock.calls[0]
    expect(table).toBe('offer_purchases')
    expect(row).toEqual(expect.objectContaining({
      id: 'op-1', offer_id: 'offer-h1', location_id: 'loc-h', contact_id: 'c1',
      buyer_name: 'Ava Doe', buyer_email: 'ava@example.com', buyer_phone: '0871234567',
      amount_cents: 59700, currency: 'EUR',
      payment_provider: 'un1t_online', origin: 'page', state: 'created', un1t_product_id: 'prod-3m',
      terms_accepted_at: TERMS.terms_accepted_at, terms_source: 'website', terms_version: 'v3',
    }))
    expect(row.revolut_order_id).toBeUndefined()
    expect(mocks.ensureAccount).toHaveBeenCalledWith(db, expect.objectContaining({
      locationId: 'loc-h', organizationId: 'org1', contact: CONTACT,
      request: expect.objectContaining(TERMS), origin: 'web_offer', originRef: 'op-1', actor: null,
    }))
    expect(patches()).toEqual([{ un1t_user_id: 'u-1' }])
    // every stamp is fenced to the row and its studio
    expect(mocks.updated.mock.calls[0][2]).toEqual([['id', 'op-1'], ['location_id', 'loc-h']])
    expect(mocks.checkout).toHaveBeenCalledWith(db, expect.objectContaining({
      locationId: 'loc-h', userId: 'u-1', productId: 'prod-3m',
      successUrl: 'https://un1t-group.repset.ie/offers/hatch-street/3-month-membership?purchase=op-1',
      cancelUrl: 'https://un1t-group.repset.ie/offers/hatch-street/3-month-membership?purchase=op-1&cancelled=1',
      idempotencyKey: 'offer_purchase:op-1', origin: 'web_offer', originRef: 'op-1', actor: null,
    }))
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('a failed insert is unavailable and nothing reaches un1t.online', async () => {
    mocks.inserted.mockResolvedValue({ error: { code: '23505', details: 'ava@example.com' } })
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'purchase_insert_failed' })
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
    // ids and codes only: the error details (which can name the buyer) are never logged
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('ava@example.com')
  })

  it('a settings read error or a retryable refusal marks the row failed and is unavailable, no alert', async () => {
    mocks.ensureAccount.mockRejectedValueOnce(new Un1tSettingsReadError('down', { code: 'connection_read_failed' }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'connection_read_failed' })
    expect(patches()).toEqual([{ state: 'failed', last_error: 'connection_read_failed' }])

    vi.clearAllMocks()
    mocks.inserted.mockResolvedValue({ error: null })
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockRejectedValueOnce(new Un1tWriteRefused('rate_limited', 'busy', { retryable: true }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'rate_limited' })
    expect(patches()).toEqual([{ state: 'failed', last_error: 'rate_limited' }])

    vi.clearAllMocks()
    mocks.inserted.mockResolvedValue({ error: null })
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockResolvedValueOnce({ kind: 'retry', code: 'un1t_throttled' })
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'un1t_throttled' })
    expect(mocks.alert).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('an account card files help: row failed with the reason, one ops alert naming the buyer', async () => {
    mocks.ensureAccount.mockResolvedValue({ kind: 'card', reason: 'account_ambiguous' })
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches()).toEqual([{ state: 'failed', last_error: 'un1t_account_refused: account_ambiguous' }])
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    const [alert, opts] = mocks.alert.mock.calls[0]
    expect(opts).toEqual({ db })
    expect(alert.subject).toBe('BLACK FRIDAY: Ava Doe needs help buying 3 Month Membership')
    expect(alert.organizationId).toBe('org1')
    expect(alert.locationId).toBe('loc-h')
    expect(alert.htmlBody).toContain('ava@example.com')
    expect(alert.htmlBody).toContain('0871234567')
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  // BLACKFRIDAY.9 — the help alert escapes its HTML and keeps the subject on one line.
  it('the help alert escapes the buyer and offer and collapses newlines in the subject', async () => {
    mocks.ensureAccount.mockResolvedValue({ kind: 'card', reason: 'account_ambiguous' })
    await startUn1tOfferCheckout(db, {
      ...ARGS,
      offer: { ...OFFER, name: '3 Month\nMembership' },
      buyer: { name: 'Ava\r\n<a href=x>Doe</a>', email: 'a<b>@example.com', phone: '<i>' },
    })
    const [alert] = mocks.alert.mock.calls[0]
    expect(alert.subject).toBe('BLACK FRIDAY: Ava <a href=x>Doe</a> needs help buying 3 Month Membership')
    expect(alert.subject).not.toMatch(/[\r\n]/)
    expect(alert.pushBody).not.toMatch(/[\r\n]/)
    expect(alert.htmlBody).not.toContain('<a href=x>')
    expect(alert.htmlBody).toContain('&lt;a href=x&gt;')
    expect(alert.htmlBody).not.toContain('<b>')
    expect(alert.htmlBody).not.toContain('<i>')
  })

  it('a non-retryable thrown refusal is help; a thrown read error is unavailable', async () => {
    mocks.ensureAccount.mockRejectedValueOnce(new Un1tWriteRefused('UN1T_WRITES_OFF', 'off', { retryable: false }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches()).toEqual([{ state: 'failed', last_error: 'un1t_account_refused: UN1T_WRITES_OFF' }])

    vi.clearAllMocks()
    mocks.inserted.mockResolvedValue({ error: null })
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockRejectedValueOnce(new Error('un1t_clients read failed'))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'un1t_account_unreadable' })
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('a un1t_user_id that cannot be stamped stops before the checkout', async () => {
    mocks.updated.mockResolvedValueOnce({ error: { code: '57014' } })
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'un1t_user_unstamped' })
    expect(patches()).toEqual([{ un1t_user_id: 'u-1' }, { state: 'failed', last_error: 'un1t_user_unstamped' }])
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('a checkout refusal, an unclear answer and a "free" answer each file help once', async () => {
    mocks.checkout.mockRejectedValueOnce(new Un1tWriteRefused('product_not_sellable', 'no', { retryable: false }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches().at(-1)).toEqual({ state: 'failed', last_error: 'un1t_checkout_refused: product_not_sellable' })
    expect(mocks.alert).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mocks.inserted.mockResolvedValue({ error: null })
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1' })
    mocks.checkout.mockRejectedValueOnce(new Un1tWriteUnknown('outcome_unknown', 'unclear'))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches().at(-1)).toEqual({ state: 'failed', last_error: 'un1t_outcome_unknown: outcome_unknown' })
    expect(mocks.alert).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mocks.inserted.mockResolvedValue({ error: null })
    mocks.updated.mockResolvedValue({ error: null })
    mocks.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1' })
    mocks.checkout.mockResolvedValueOnce({ checkoutUrl: null, free: true, ledgerId: 'led-2' })
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'help_filed' })
    expect(patches().at(-1)).toEqual({ state: 'failed', last_error: 'un1t_outcome_unknown: checkout_free' })
  })

  it('a settings read error or a retryable refusal from the checkout is unavailable, no alert', async () => {
    mocks.checkout.mockRejectedValueOnce(new Un1tSettingsReadError('host', { code: 'customer_url_unreadable' }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'customer_url_unreadable' })
    expect(patches().at(-1)).toEqual({ state: 'failed', last_error: 'customer_url_unreadable' })

    mocks.checkout.mockRejectedValueOnce(new Un1tWriteRefused('budget_exhausted', 'later', { retryable: true }))
    expect(await startUn1tOfferCheckout(db, ARGS)).toEqual({ kind: 'unavailable', code: 'budget_exhausted' })
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('escapes the buyer name in the alert body and survives an alert that throws', async () => {
    mocks.ensureAccount.mockResolvedValue({ kind: 'card', reason: 'terms_not_accepted' })
    mocks.alert.mockRejectedValue(new Error('postmark down'))
    const buyer = { ...BUYER, name: '<b>Ava</b>' }
    expect(await startUn1tOfferCheckout(db, { ...ARGS, buyer })).toEqual({ kind: 'help_filed' })
    expect(mocks.alert.mock.calls[0][0].htmlBody).not.toContain('<b>Ava</b>')
  })
})
