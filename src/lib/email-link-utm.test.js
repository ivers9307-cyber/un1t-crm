import { describe, it, expect } from 'vitest'
import { tagOwnSiteLinks, siteUrlFromUnsubscribe } from './email-link-utm'

const SITE = 'https://studio.example.ie'
const tag = (html, medium = 'campaign') => tagOwnSiteLinks(html, { siteUrl: SITE, medium })

describe('tagOwnSiteLinks (EMAILUTM.1)', () => {
  it('adds utm_source=email and utm_medium to links on the studio site', () => {
    expect(tag('<a href="https://studio.example.ie/offers">Offers</a>'))
      .toBe('<a href="https://studio.example.ie/offers?utm_source=email&amp;utm_medium=campaign">Offers</a>')
  })

  it('keeps existing query parameters, HTML-escaped', () => {
    expect(tag('<a href="https://studio.example.ie/trial?class=hiit&amp;day=mon">x</a>', 'automation'))
      .toBe('<a href="https://studio.example.ie/trial?class=hiit&amp;day=mon&amp;utm_source=email&amp;utm_medium=automation">x</a>')
  })

  it('never adds the ad-signal parameters', () => {
    const out = tag('<a href="https://studio.example.ie/trial">x</a>')
    for (const k of ['utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'meta_ad_id']) expect(out).not.toContain(k)
  })

  it('leaves third-party, system and already-tagged links alone', () => {
    const html = [
      '<a href="https://instagram.com/studio">ig</a>',
      '<a href="https://studio.example.ie/unsubscribe/abc">u</a>',
      '<a href="https://studio.example.ie/preferences/abc">p</a>',
      '<a href="https://studio.example.ie/view-email/abc">v</a>',
      '<a href="https://studio.example.ie/offers?utm_source=newsletter">n</a>',
      '<a href="mailto:hi@studio.example.ie">m</a>',
    ].join('')
    expect(tag(html)).toBe(html)
  })

  it('does nothing without a site URL', () => {
    const html = '<a href="https://studio.example.ie/offers">x</a>'
    expect(tagOwnSiteLinks(html, { siteUrl: null, medium: 'campaign' })).toBe(html)
  })
})

describe('siteUrlFromUnsubscribe', () => {
  it('is the origin of the unsubscribe link', () => {
    expect(siteUrlFromUnsubscribe('https://studio.example.ie/unsubscribe/t?l=1')).toBe('https://studio.example.ie')
    expect(siteUrlFromUnsubscribe(null)).toBe(null)
  })
})
