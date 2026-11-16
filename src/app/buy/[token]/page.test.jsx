// PAYLINK.1 — the /buy/<token> page. loadBuyPage (tested in
// src/lib/staff-payment-link-checkout.test.js) is faked at its module
// boundary; here: an unknown token 404s, the terms tick shows only for a new
// customer, the plain states, and the ?paid=1 return (never "not paid").
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ notFound: (...a) => notFound(...a), redirect: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ fake: true }) }))
const load = vi.fn()
vi.mock('@/lib/staff-payment-link-checkout', async (orig) => {
  const real = await orig()
  return { ...real, loadBuyPage: (...a) => load(...a) }
})

import Page, { metadata, dynamic } from './page.js'
import { buyPageCopy } from '@/lib/staff-payment-link-checkout'

const TOKEN = 'a'.repeat(43)
const COPY = buyPageCopy(null)
const BRAND = { companyName: 'UN1T Hatch Street', studioName: 'UN1T Hatch Street', logoUrl: 'https://cdn.test/logo.png' }
const TERMS = {
  required: true, label: 'I accept the {terms} and the {waiver} of UN1T Hatch Street', terms_link_label: 'terms',
  waiver_link_label: 'liability waiver', required_message: 'Please accept the terms.',
  terms_url: '/legal/un1t/hatch-street/terms', waiver_url: '/legal/un1t/hatch-street/waiver',
}
const APPS = { iosUrl: 'https://apps.apple.com/x', androidUrl: 'https://play.google.com/y', heading: 'Get the app', body: 'Book in the app.' }
const READY = {
  kind: 'ready', branding: BRAND, copy: COPY, product: { title: '10 Class Pack', price_label: '€130' },
  person: { first_name: 'Aoife', email: 'aoife@example.com' }, isNew: true, terms: TERMS, appLinks: APPS, createdAccount: false,
}
const esc = (t) => t.replace(/'/g, '&#x27;')
const render = async (searchParams = {}) => renderToStaticMarkup(await Page({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(searchParams) }))

beforeEach(() => { vi.clearAllMocks() })

describe('/buy/<token>', () => {
  it('is noindex, sends no referrer and is never cached', () => {
    expect(metadata.robots.index).toBe(false)
    expect(metadata.referrer).toBe('no-referrer')
    expect(dynamic).toBe('force-dynamic')
  })

  it('an unknown token is a 404', async () => {
    load.mockResolvedValue({ kind: 'not_found' })
    await expect(render()).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })

  it('a new customer: product, price, their name and email, the terms tick and the button', async () => {
    load.mockResolvedValue(READY)
    const html = await render()
    expect(load).toHaveBeenCalledWith({ fake: true }, TOKEN)
    expect(html).toContain('10 Class Pack')
    expect(html).toContain('€130')
    expect(html).toContain('aoife@example.com')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('/legal/un1t/hatch-street/terms')
    expect(html).toContain('/legal/un1t/hatch-street/waiver')
    expect(html).toContain('Continue to payment')
    expect(html).toContain(esc(COPY.not_you_text))
  })

  it('an existing member: the same page with no tick', async () => {
    load.mockResolvedValue({ ...READY, isNew: false, terms: null })
    const html = await render()
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('Continue to payment')
  })

  it('paid / expired / unavailable: the plain state pages with the studio', async () => {
    for (const [kind, text] of [['paid', COPY.paid_text], ['expired', COPY.expired_text], ['unavailable', COPY.unavailable_text]]) {
      load.mockResolvedValue({ kind, branding: BRAND, copy: COPY, person: READY.person, appLinks: APPS })
      const html = await render()
      expect(html).toContain(esc(text))
      expect(html).toContain('UN1T Hatch Street')
      expect(html).not.toContain('type="checkbox"')
    }
  })

  it('?paid=1 on a paid link: you are in, app links, and the set-password line for a CRM-made account', async () => {
    load.mockResolvedValue({ kind: 'paid', branding: BRAND, copy: COPY, person: READY.person, appLinks: APPS, createdAccount: true })
    const html = await render({ paid: '1' })
    expect(html).toContain(esc("You're in, Aoife!"))
    expect(html).toContain('https://apps.apple.com/x')
    expect(html).toContain('https://play.google.com/y')
    expect(html).toContain(esc(COPY.set_password_text))
  })

  it('?paid=1 with an account that already existed: no set-password line', async () => {
    load.mockResolvedValue({ kind: 'paid', branding: BRAND, copy: COPY, person: READY.person, appLinks: APPS, createdAccount: false })
    const html = await render({ paid: '1' })
    expect(html).not.toContain(esc(COPY.set_password_text))
  })

  it('?paid=1 before the payment is seen: confirming, never "not paid", never the button', async () => {
    load.mockResolvedValue(READY)
    const html = await render({ paid: '1' })
    expect(html).toContain(esc("Thanks, Aoife! We're confirming your payment."))
    expect(html).not.toContain('Continue to payment')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toMatch(/not paid/i)
  })

  it('?paid=1 on an expired, revoked or product-gone link shows that state, not confirming', async () => {
    load.mockResolvedValue({ kind: 'expired', branding: BRAND, copy: COPY, person: READY.person, appLinks: APPS })
    const html = await render({ paid: '1' })
    expect(html).toContain(esc(COPY.expired_text))
    expect(html).not.toContain('confirming your payment')
  })

  it('a name carrying replacement patterns is shown literally', async () => {
    load.mockResolvedValue({ kind: 'paid', branding: BRAND, copy: COPY, person: { first_name: '$&$1', email: '' }, appLinks: APPS })
    const html = await render({ paid: '1' })
    expect(html).toContain(esc("You're in, $&amp;$1!"))
  })

  it('a loader that throws is the try-again page', async () => {
    load.mockRejectedValue(new Error('boom'))
    expect(await render()).toContain(esc(COPY.unavailable_text))
  })

  it('the page copy has no em or en dashes', () => {
    for (const t of Object.values(COPY)) if (typeof t === 'string') expect(t).not.toMatch(/[—–]/)
  })
})
