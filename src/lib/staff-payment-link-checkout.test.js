// STAFFPAYLINK.1 — the public /buy/<token> page's two halves: loadBuyPage (GET,
// reads only, may stamp `opened`) and startStaffLinkCheckout (POST: account,
// then un1t.online's hosted checkout). What it pins:
//   - GET never calls un1t.online (no account, no checkout, no legal read);
//   - a payment already in the mirror is never sent to pay again;
//   - the contact is read fresh by id on every POST;
//   - a new customer with no tick gets terms_required and no account;
//   - every account card reason is the help page, recorded on last_error;
//   - each checkout has its own key (paylink:<id>:r<checkout_count>);
//   - a free answer and an unsellable product.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const m = vi.hoisted(() => ({
  ensureAccount: vi.fn(), createLink: vi.fn(), baseUrl: vi.fn(), branding: vi.fn(), termsCopy: vi.fn(),
  publicPath: vi.fn(), legalDocs: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: m.ensureAccount }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: m.createLink }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: m.baseUrl }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: m.branding }))
vi.mock('@/lib/landing-pages', () => ({ studioTermsCopy: m.termsCopy, studioPublicPath: m.publicPath }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: m.legalDocs }))
vi.mock('@/lib/log', () => ({ logWarn: m.warn, logError: m.error, logInfo: vi.fn() }))

import { loadBuyPage, startStaffLinkCheckout, buyPageCopy, fillFirstName, isReusableCheckoutUrl, PAYLINK_CHECKOUT_COOLDOWN_MS } from './staff-payment-link-checkout'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const TOKEN = 'a'.repeat(43)
const LINK = {
  id: 'link-1', location_id: 'loc-h', organization_id: 'org-1', contact_id: 'c-1', un1t_product_id: 'prod-1',
  product_title: '10 Class Pack', price_cents: 12500, status: 'sent', un1t_user_id: null, terms_accepted_at: null,
  checkout_count: 0, last_checkout_ledger_id: null, paid_transaction_id: null, paid_at: null,
  created_at: iso(NOW - 60 * 60_000), expires_at: iso(NOW + 6 * 24 * 60 * 60_000),
}
const CONTACT = { id: 'c-1', first_name: 'Aoife', last_name: 'Byrne', name: 'Aoife Byrne', email: 'aoife@example.com', phone: '+353871234567', un1t_user_id: null, organization_id: 'org-1' }
const LOCATION = { id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org-1', settings: { un1t_online: { payment_link: { paid_text: 'Paid, thanks!' }, app_links: { ios_url: 'https://apps.apple.com/x', android_url: 'https://play.google.com/y' } } } }
const PRODUCT = { un1t_id: 'prod-1', title: '10 Class Pack', type: 'pack', status: 'active', price_cents: 13000, currency: 'EUR', billing_interval: null, billing_interval_count: null }
const tx = (over = {}) => ({ un1t_id: 'tx-1', un1t_user_id: 'u-1', product_id: 'prod-1', type: 'purchase', amount_cents: 13000, refunded: false, remote_created_at: iso(NOW - 5 * 60_000), ...over })

// A recording fake: reads answer from `rows` (or `fail` → an error); updates
// are recorded and answer `updateHits` rows.
function makeDb({ link = LINK, contact = CONTACT, location = LOCATION, product = PRODUCT, txs = [], ledger = [], fail = {}, updateHits = 1 } = {}) {
  const reads = []
  const updates = []
  const db = {
    reads, updates,
    from(table) {
      const filters = []
      let patch = null
      let cols = null
      const settle = async () => {
        if (patch) {
          updates.push({ table, patch, filters: [...filters] })
          if (fail[`${table}.update`]) return { data: null, error: { code: 'XX000', message: 'boom' } }
          return { data: Array.from({ length: updateHits }, () => ({ id: 'x' })), error: null }
        }
        reads.push({ table, cols, filters: [...filters] })
        if (fail[table]) return { data: null, error: { code: 'XX000', message: 'boom' } }
        if (table === 'staff_payment_links') return { data: link, error: null }
        if (table === 'contacts') return { data: contact, error: null }
        if (table === 'locations') return { data: location, error: null }
        if (table === 'un1t_products') return { data: product, error: null }
        if (table === 'un1t_transactions') return { data: txs, error: null }
        if (table === 'un1t_write_events') return { data: ledger, error: null }
        throw new Error(`unexpected read of ${table}`)
      }
      const b = {
        select: (c) => { if (!patch) cols = c; return b },
        update: (p) => { patch = p; return b },
        maybeSingle: () => settle(),
        single: () => settle(),
        then: (res, rej) => settle().then(res, rej),
      }
      for (const op of ['eq', 'in', 'gte', 'order', 'range', 'limit']) b[op] = (...args) => { filters.push([op, ...args]); return b }
      return b
    },
  }
  return db
}

const linkUpdates = (db) => db.updates.filter((u) => u.table === 'staff_payment_links')

beforeEach(() => {
  vi.clearAllMocks()
  m.baseUrl.mockResolvedValue('https://hatch.example.com')
  m.branding.mockResolvedValue({ companyName: 'UN1T Hatch Street', logoUrl: 'https://cdn.test/logo.png' })
  m.termsCopy.mockResolvedValue({})
  m.publicPath.mockResolvedValue('hatch-street')
  m.legalDocs.mockResolvedValue({ terms: {}, waiver: {}, version: 'terms:1|waiver:1' })
  m.ensureAccount.mockResolvedValue({ kind: 'created', un1tUserId: 'u-1', executingContactId: 'c-1' })
  m.createLink.mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/c/pay/abc', free: false, ledgerId: 'led-1' })
})

describe('loadBuyPage (GET)', () => {
  it('GET makes no un1t.online call', async () => {
    const db = makeDb()
    const out = await loadBuyPage(db, TOKEN, { now: NOW })
    expect(out.kind).toBe('ready')
    expect(m.ensureAccount).not.toHaveBeenCalled()
    expect(m.createLink).not.toHaveBeenCalled()
    expect(m.legalDocs).not.toHaveBeenCalled()
  })

  it('a new customer: the current price, the person, and the tick', async () => {
    const out = await loadBuyPage(makeDb(), TOKEN, { now: NOW })
    expect(out.isNew).toBe(true)
    expect(out.product.title).toBe('10 Class Pack')
    expect(out.product.price_label).toContain('130')
    expect(out.person).toEqual({ first_name: 'Aoife', email: 'aoife@example.com' })
    expect(out.terms?.terms_url).toBe('/legal/un1t/hatch-street/terms')
  })

  it('an existing member (linked contact) sees no tick, but the terms ride along for a terms_required answer', async () => {
    const out = await loadBuyPage(makeDb({ contact: { ...CONTACT, un1t_user_id: 'u-9' } }), TOKEN, { now: NOW })
    expect(out.kind).toBe('ready')
    expect(out.isNew).toBe(false)
    expect(out.terms?.terms_url).toBe('/legal/un1t/hatch-street/terms')
  })

  it('an existing member at a studio with no studio page still gets the page (no terms)', async () => {
    m.publicPath.mockResolvedValue(null)
    const out = await loadBuyPage(makeDb({ contact: { ...CONTACT, un1t_user_id: 'u-9' } }), TOKEN, { now: NOW })
    expect(out.kind).toBe('ready')
    expect(out.terms).toBe(null)
  })

  it('stamps opened on the first open only (the only GET write)', async () => {
    const db = makeDb()
    await loadBuyPage(db, TOKEN, { now: NOW })
    const ups = linkUpdates(db)
    expect(ups).toHaveLength(1)
    expect(ups[0].patch.status).toBe('opened')
    expect(ups[0].filters).toContainEqual(['eq', 'status', 'sent'])
  })

  it('an unknown token is not_found', async () => {
    expect((await loadBuyPage(makeDb({ link: null }), TOKEN, { now: NOW })).kind).toBe('not_found')
  })

  it('a link read error is unavailable, never not_found', async () => {
    expect((await loadBuyPage(makeDb({ fail: { staff_payment_links: true } }), TOKEN, { now: NOW })).kind).toBe('unavailable')
  })

  it('a product no longer sold is the expired page', async () => {
    const out = await loadBuyPage(makeDb({ product: { ...PRODUCT, status: 'archived' } }), TOKEN, { now: NOW })
    expect(out.kind).toBe('expired')
  })

  it('a past-expiry link is expired; a paid one is paid', async () => {
    expect((await loadBuyPage(makeDb({ link: { ...LINK, expires_at: iso(NOW - 1) } }), TOKEN, { now: NOW })).kind).toBe('expired')
    const paid = await loadBuyPage(makeDb({ link: { ...LINK, status: 'paid', terms_accepted_at: iso(NOW - 1000) } }), TOKEN, { now: NOW })
    expect(paid.kind).toBe('paid')
    expect(paid.createdAccount).toBe(true)
    expect(paid.person.first_name).toBe('Aoife')
  })

  it('a payment the mirror holds reads as paid without a write to un1t.online or the row', async () => {
    const db = makeDb({ link: { ...LINK, status: 'checkout_started', un1t_user_id: 'u-1' }, txs: [tx()] })
    const out = await loadBuyPage(db, TOKEN, { now: NOW })
    expect(out.kind).toBe('paid')
    expect(linkUpdates(db)).toHaveLength(0)
  })

  it('the studio copy and app links ride on the answer', async () => {
    const out = await loadBuyPage(makeDb(), TOKEN, { now: NOW })
    expect(out.copy.paid_text).toBe('Paid, thanks!')
    expect(out.appLinks.iosUrl).toBe('https://apps.apple.com/x')
  })
})

describe('startStaffLinkCheckout (POST)', () => {
  const run = (db, over = {}) => startStaffLinkCheckout(db, { token: TOKEN, acceptTerms: true, now: NOW, ...over })

  it('a new customer who ticked: account created with the recorded terms, then the checkout', async () => {
    const db = makeDb()
    const out = await run(db)
    expect(out).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/abc' })
    const args = m.ensureAccount.mock.calls[0][1]
    expect(args.request).toEqual({ terms_accepted_at: iso(NOW), terms_source: 'buy_page', terms_version: 'terms:1|waiver:1' })
    expect(args.origin).toBe('staff_payment_link')
    expect(args.originRef).toBe('link-1')
    const ck = m.createLink.mock.calls[0][1]
    expect(ck).toMatchObject({
      locationId: 'loc-h', userId: 'u-1', productId: 'prod-1', origin: 'staff_payment_link', originRef: 'link-1',
      idempotencyKey: 'paylink:link-1:r0',
      successUrl: `https://hatch.example.com/buy/${TOKEN}?paid=1`,
      cancelUrl: `https://hatch.example.com/buy/${TOKEN}?cancelled=1`,
    })
    const ups = linkUpdates(db)
    // un1t_user_id + terms stamped BEFORE the checkout, then the checkout stamp.
    expect(ups[0].patch).toMatchObject({ un1t_user_id: 'u-1', terms_accepted_at: iso(NOW) })
    expect(ups[1].patch).toMatchObject({ status: 'checkout_started', checkout_count: 1, last_checkout_ledger_id: 'led-1' })
    // the checkout URL is never written to the row
    expect(JSON.stringify(db.updates)).not.toContain('checkout.stripe.com')
  })

  it('an existing account: no terms stamp', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' })
    const db = makeDb()
    await run(db, { acceptTerms: false })
    expect(m.ensureAccount.mock.calls[0][1].request).toBe(null)
    expect(linkUpdates(db)[0].patch.terms_accepted_at).toBeUndefined()
    expect(m.legalDocs).not.toHaveBeenCalled()
  })

  it('reads the contact fresh on POST', async () => {
    const db = makeDb()
    await run(db)
    const read = db.reads.find((r) => r.table === 'contacts')
    expect(read.filters).toContainEqual(['eq', 'id', 'c-1'])
    expect(read.cols).not.toContain('*')
    expect(m.ensureAccount.mock.calls[0][1].contact).toEqual(CONTACT)
  })

  it('new customer without ticks → terms_required, no create', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'card', reason: 'terms_not_accepted' })
    const db = makeDb()
    const out = await run(db, { acceptTerms: false })
    expect(out).toEqual({ kind: 'terms_required' })
    expect(m.ensureAccount.mock.calls[0][1].request).toBe(null)
    expect(m.createLink).not.toHaveBeenCalled()
    expect(linkUpdates(db)).toHaveLength(0)
  })

  it('account card reasons render the help page (last_error stamped)', async () => {
    for (const reason of ['account_ambiguous', 'un1t_email_in_use_elsewhere', 'un1t_link_conflict']) {
      m.ensureAccount.mockResolvedValueOnce({ kind: 'card', reason })
      const db = makeDb()
      const out = await run(db)
      expect(out).toEqual({ kind: 'help', reason })
      expect(linkUpdates(db).at(-1).patch.last_error).toBe(reason)
      expect(m.createLink).not.toHaveBeenCalled()
    }
  })

  it('an account retry is unavailable', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'retry', code: 'budget' })
    expect((await run(makeDb())).kind).toBe('unavailable')
  })

  it('refuses checkout when the mirror shows the payment, and never stamps the row paid (the sweep settles)', async () => {
    const db = makeDb({ link: { ...LINK, status: 'checkout_started', un1t_user_id: 'u-1' }, txs: [tx()] })
    const out = await run(db)
    expect(out.kind).toBe('paid')
    expect(m.ensureAccount).not.toHaveBeenCalled()
    expect(m.createLink).not.toHaveBeenCalled()
    expect(linkUpdates(db)).toHaveLength(0)
  })

  it('a payment under the contact\'s account on a link with no account: paid, only the account stamped', async () => {
    const db = makeDb({ contact: { ...CONTACT, un1t_user_id: 'u-1' }, txs: [tx()] })
    const out = await run(db)
    expect(out.kind).toBe('paid')
    const ups = linkUpdates(db)
    expect(ups).toHaveLength(1)
    expect(ups[0].patch).toMatchObject({ un1t_user_id: 'u-1' })
    expect(ups[0].patch.status).toBeUndefined()
  })

  it('a payment found with the account just resolved is never sent to pay', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' })
    const db = makeDb({ txs: [tx()] })
    const out = await run(db)
    expect(out.kind).toBe('paid')
    expect(m.createLink).not.toHaveBeenCalled()
  })

  it('a mirror read that fails is unavailable, never a checkout', async () => {
    const db = makeDb({ link: { ...LINK, un1t_user_id: 'u-1' }, fail: { un1t_transactions: true } })
    expect((await run(db)).kind).toBe('unavailable')
    expect(m.createLink).not.toHaveBeenCalled()
  })

  it('idempotency key increments per checkout', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' })
    const db = makeDb({ link: { ...LINK, status: 'checkout_started', un1t_user_id: 'u-1', checkout_count: 2 } })
    await run(db)
    expect(m.createLink.mock.calls[0][1].idempotencyKey).toBe('paylink:link-1:r2')
    const stamp = linkUpdates(db).find((u) => u.patch.status === 'checkout_started')
    expect(stamp.patch.checkout_count).toBe(3)
  })

  it('free: true is never read as paid: help, last_error checkout_free (Ruling H)', async () => {
    m.createLink.mockResolvedValue({ checkoutUrl: null, free: true, ledgerId: 'led-2' })
    const db = makeDb()
    expect(await run(db)).toEqual({ kind: 'help', reason: 'checkout_free' })
    expect(linkUpdates(db).some((u) => u.patch.status === 'paid')).toBe(false)
    expect(linkUpdates(db).at(-1).patch.last_error).toBe('checkout_free')
  })

  it('expired product → expired', async () => {
    const db = makeDb({ product: { ...PRODUCT, price_cents: 0 } })
    expect((await run(db)).kind).toBe('expired')
    expect(m.ensureAccount).not.toHaveBeenCalled()
  })

  describe('a recent checkout (Ruling J)', () => {
    const MIN = 60_000
    const LIVE_LINK = { ...LINK, status: 'checkout_started', un1t_user_id: 'u-1', checkout_count: 1 }
    const event = (over = {}) => ({ id: 'led-1', stage: 'done', checkout_url: 'https://checkout.stripe.com/c/pay/first', idempotency_key: 'paylink:link-1:r0', created_at: iso(NOW - 5 * MIN), ...over })
    beforeEach(() => { m.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' }) })

    it('a fresh done checkout is handed back: same URL, no new key, no count bump', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event()] })
      expect(await run(db, { acceptTerms: false })).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/first' })
      expect(m.createLink).not.toHaveBeenCalled()
      expect(linkUpdates(db).some((u) => 'checkout_count' in u.patch)).toBe(false)
      const read = db.reads.find((r) => r.table === 'un1t_write_events')
      expect(read.filters).toEqual(expect.arrayContaining([
        ['eq', 'location_id', 'loc-h'], ['eq', 'op', 'checkout'], ['eq', 'origin_ref', 'link-1'],
        ['eq', 'un1t_user_id', 'u-1'], ['eq', 'target', 'prod-1'], ['range', 0, 99],
      ]))
    })

    it('a stored checkout that is not https, or is on our own host, is never handed back', async () => {
      for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://hatch.example.com/buy/zzz', 'javascript:alert(1)', 'not a url']) {
        m.createLink.mockClear()
        const db = makeDb({ link: LIVE_LINK, ledger: [event({ checkout_url: url })] })
        expect(await run(db)).toEqual({ kind: 'confirming' })
        expect(m.createLink).not.toHaveBeenCalled()
      }
    })

    it('isReusableCheckoutUrl: https on another host only', () => {
      expect(isReusableCheckoutUrl('https://checkout.stripe.com/x', 'https://hatch.example.com')).toBe(true)
      expect(isReusableCheckoutUrl('https://HATCH.example.com/x', 'https://hatch.example.com')).toBe(false)
      expect(isReusableCheckoutUrl('http://checkout.stripe.com/x', 'https://hatch.example.com')).toBe(false)
      expect(isReusableCheckoutUrl('https://checkout.stripe.com/x', null)).toBe(false)
    })

    it('a checkout 30 minutes old: confirming, no new checkout', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ created_at: iso(NOW - 30 * MIN) })] })
      expect(await run(db)).toEqual({ kind: 'confirming' })
      expect(m.createLink).not.toHaveBeenCalled()
    })

    it('an attempt still in doubt 30 minutes old: confirming too', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ stage: 'unknown', checkout_url: null, created_at: iso(NOW - 30 * MIN) })] })
      expect((await run(db)).kind).toBe('confirming')
      expect(m.createLink).not.toHaveBeenCalled()
    })

    it('an attempt still open under 20 minutes resumes under its SAME key', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ stage: 'sent', checkout_url: null, idempotency_key: 'paylink:link-1:r1', created_at: iso(NOW - 2 * MIN) })] })
      expect((await run(db)).kind).toBe('redirect')
      expect(m.createLink.mock.calls[0][1].idempotencyKey).toBe('paylink:link-1:r1')
      expect(linkUpdates(db).find((u) => u.patch.status === 'checkout_started').patch.checkout_count).toBe(2)
    })

    it('a checkout 61 minutes old and an empty mirror: a new key r<n>', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ created_at: iso(NOW - 61 * MIN) })] })
      expect((await run(db)).kind).toBe('redirect')
      expect(m.createLink.mock.calls[0][1].idempotencyKey).toBe('paylink:link-1:r1')
      expect(PAYLINK_CHECKOUT_COOLDOWN_MS).toBe(60 * MIN)
    })

    it('the new key skips past every key the ledger holds (a lost count stamp)', async () => {
      const db = makeDb({ link: { ...LIVE_LINK, checkout_count: 0 }, ledger: [event({ idempotency_key: 'paylink:link-1:r3', created_at: iso(NOW - 90 * MIN) })] })
      await run(db)
      expect(m.createLink.mock.calls[0][1].idempotencyKey).toBe('paylink:link-1:r4')
    })

    it('a refused newest attempt does not hold the customer back', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ stage: 'refused', checkout_url: null, created_at: iso(NOW - 3 * MIN) })] })
      expect((await run(db)).kind).toBe('redirect')
      expect(m.createLink).toHaveBeenCalledTimes(1)
    })

    it('a 61-minute-old checkout with the payment in the mirror: paid, no checkout', async () => {
      const db = makeDb({ link: LIVE_LINK, ledger: [event({ created_at: iso(NOW - 61 * MIN) })], txs: [tx()] })
      expect((await run(db)).kind).toBe('paid')
      expect(m.createLink).not.toHaveBeenCalled()
    })

    it('a ledger read error is unavailable, no checkout', async () => {
      const db = makeDb({ link: LIVE_LINK, fail: { un1t_write_events: true } })
      expect((await run(db)).kind).toBe('unavailable')
      expect(m.createLink).not.toHaveBeenCalled()
    })
  })

  it('a link that is not live answers its state', async () => {
    expect((await run(makeDb({ link: { ...LINK, status: 'paid' } }))).kind).toBe('paid')
    expect((await run(makeDb({ link: { ...LINK, status: 'revoked' } }))).kind).toBe('expired')
    expect((await run(makeDb({ link: null }))).kind).toBe('not_found')
    expect(m.ensureAccount).not.toHaveBeenCalled()
  })

  it('checkout errors: retryable / settings / unknown → unavailable; other refusal → help', async () => {
    m.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-1', executingContactId: 'c-1' })
    m.createLink.mockRejectedValueOnce(new Un1tWriteRefused('rate_limited', 'x', { retryable: true }))
    expect((await run(makeDb())).kind).toBe('unavailable')
    m.createLink.mockRejectedValueOnce(new Un1tSettingsReadError('x', { code: 'mirror_read_failed' }))
    expect((await run(makeDb())).kind).toBe('unavailable')
    m.createLink.mockRejectedValueOnce(new Un1tWriteUnknown('outcome_unknown', 'x'))
    expect((await run(makeDb())).kind).toBe('unavailable')
    m.createLink.mockRejectedValueOnce(new Un1tWriteRefused('product_not_sellable', 'x', { retryable: false }))
    const db = makeDb()
    expect(await run(db)).toEqual({ kind: 'help', reason: 'product_not_sellable' })
    expect(linkUpdates(db).at(-1).patch.last_error).toBe('product_not_sellable')
  })

  it('the un1t_user_id stamp failing means no checkout', async () => {
    const db = makeDb({ fail: { 'staff_payment_links.update': true } })
    expect((await run(db)).kind).toBe('unavailable')
    expect(m.createLink).not.toHaveBeenCalled()
  })

  it('a legal-docs read failure still records the acceptance (version null)', async () => {
    m.legalDocs.mockRejectedValue(new Error('down'))
    await run(makeDb())
    expect(m.ensureAccount.mock.calls[0][1].request).toEqual({ terms_accepted_at: iso(NOW), terms_source: 'buy_page', terms_version: null })
  })

  it('never logs the token or the checkout URL', async () => {
    m.createLink.mockRejectedValueOnce(new Un1tWriteRefused('product_not_sellable', 'x', { retryable: false }))
    await run(makeDb())
    m.ensureAccount.mockResolvedValueOnce({ kind: 'card', reason: 'account_ambiguous' })
    await run(makeDb())
    const logged = JSON.stringify([...m.warn.mock.calls, ...m.error.mock.calls])
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('checkout.stripe.com')
  })
})

describe('fillFirstName', () => {
  it('a name with replacement patterns is put in literally', () => {
    expect(fillFirstName("You're in, {first_name}!", '$&$1')).toBe("You're in, $&$1!")
  })
  it('no name: the token and its comma go', () => {
    expect(fillFirstName("You're in, {first_name}!", '')).toBe("You're in!")
  })
})

describe('buyPageCopy', () => {
  it('the page lines over defaults, operator-editable', () => {
    const c = buyPageCopy({ payment_link: { continue_button: 'Pay' } })
    expect(c.continue_button).toBe('Pay')
    expect(c.paid_heading).toContain('{first_name}')
    expect(c.confirming_text).toMatch(/confirming your payment/)
  })
})
