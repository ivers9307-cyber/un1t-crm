// UN1TDUN.1 — the /pay-link/<token> page. resolveUn1tPayLink (tested in
// src/lib/un1t-pay-link.test.js) is faked at its module boundary; here: an
// open invoice redirects, an unknown token 404s, and the paid and try-again
// pages show the studio and never the Stripe URL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const redirect = vi.fn((url) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }) })
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ redirect: (...a) => redirect(...a), notFound: (...a) => notFound(...a) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ fake: true }) }))
const resolve = vi.fn()
vi.mock('@/lib/un1t-pay-link', () => ({ resolveUn1tPayLink: (...a) => resolve(...a) }))

import Page, { metadata, dynamic } from './page.js'
import { UN1T_PAY_PAGE_TEXT } from '@/lib/un1t-dunning-copy'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const STRIPE = 'https://invoice.stripe.com/i/acct_test/test_inv?s=ap'
const BRAND = { companyName: 'UN1T Hatch Street', studioName: 'Hatch Street', logoUrl: 'https://cdn.test/logo.png' }
// React escapes the apostrophes in the copy.
const esc = (t) => t.replace(/'/g, '&#x27;')
const render = async (token = TOKEN) => renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }))

beforeEach(() => { vi.clearAllMocks() })

describe('/pay-link/<token>', () => {
  it('is noindex, sends no referrer and is never cached', () => {
    expect(metadata.robots.index).toBe(false)
    expect(metadata.referrer).toBe('no-referrer')
    expect(dynamic).toBe('force-dynamic')
  })

  it('an open invoice redirects to its payment page', async () => {
    resolve.mockResolvedValue({ kind: 'redirect', url: STRIPE })
    await expect(render()).rejects.toThrow(/^NEXT_REDIRECT$/)
    expect(redirect).toHaveBeenCalledWith(STRIPE)
    expect(resolve).toHaveBeenCalledWith({ fake: true }, TOKEN)
  })

  it('an unknown token is a 404', async () => {
    resolve.mockResolvedValue({ kind: 'not_found' })
    await expect(render()).rejects.toThrow(/^NEXT_NOT_FOUND$/)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('paid: the all-paid-up page with the studio branding', async () => {
    resolve.mockResolvedValue({ kind: 'paid', branding: BRAND })
    const html = await render()
    expect(html).toContain(esc(UN1T_PAY_PAGE_TEXT.paid))
    expect(html).toContain('UN1T Hatch Street')
    expect(html).toContain('https://cdn.test/logo.png')
    expect(html).not.toContain('stripe')
  })

  it('unreachable: try again shortly, naming the studio', async () => {
    resolve.mockResolvedValue({ kind: 'unavailable', branding: BRAND })
    const html = await render()
    expect(html).toContain(esc(UN1T_PAY_PAGE_TEXT.unavailable('Hatch Street')))
    expect(html).not.toContain('stripe')
  })

  it('a resolver that throws, or no branding: the generic try-again page', async () => {
    resolve.mockRejectedValue(new Error('boom'))
    expect(await render()).toContain(esc(UN1T_PAY_PAGE_TEXT.unavailable('')))
    resolve.mockResolvedValue({ kind: 'unavailable', branding: null })
    expect(await render()).toContain(esc(UN1T_PAY_PAGE_TEXT.unavailable('')))
  })

  it('the copy has no em or en dashes', () => {
    for (const t of [UN1T_PAY_PAGE_TEXT.paid, UN1T_PAY_PAGE_TEXT.unavailable('Hatch Street'), UN1T_PAY_PAGE_TEXT.unavailable('')]) {
      expect(t).not.toMatch(/[—–]/)
    }
  })
})
