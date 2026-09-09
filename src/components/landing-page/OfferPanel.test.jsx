import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OfferPanel from './OfferPanel.jsx'

// vitest runs under the `node` environment here with no jsdom and no
// @testing-library/react. We render to static markup via
// react-dom/server and assert on the HTML, the same way
// InstagramStrip.test.jsx does.

const offer = {
  enabled: true,
  eyebrow: 'Foundation membership',
  price: '€189',
  was_price: '€219',
  was_price_note: 'a month from 19 September',
  unit: 'per month\nfixed for life',
  deadline: 'Offer ends 19 September',
  ticks: ['Unlimited classes', 'Rate never rises'],
  cta_label: 'Claim your rate',
  cta_url: 'https://hatchstreet.un1t.online/#join',
}

describe('OfferPanel (HATCH-OFFER.1)', () => {
  it('strikes the was-price and states the direction for screen readers', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('lp-was-strike')
    expect(html).toContain('€219')
    expect(html).toContain('€219 a month from 19 September')
  })
  it('hides the strike and its note entirely when there is no was-price', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, was_price: '' }} />)
    expect(html).not.toContain('lp-was-strike')
    expect(html).not.toContain('a month from 19 September')
  })
  it('links out to the checkout with rel=noopener and no target', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('href="https://hatchstreet.un1t.online/#join"')
    expect(html).toContain('rel="noopener"')
    expect(html).not.toContain('target=')
  })
  it('renders no anchor at all when the url is empty', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, cta_url: '' }} />)
    expect(html).not.toContain('<a ')
    expect(html).toContain('€189')
  })
  it('hides the deadline chip when the deadline is empty', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, deadline: '' }} />)
    expect(html).not.toContain('Offer ends')
    // Assert the ELEMENT is gone, not just its text. On a public
    // render E resolves to empty content, so a text-only assertion
    // passes even with the guard removed — what leaks is an empty
    // black pill, which only a class assertion can see.
    expect(html).not.toContain('rounded-full bg-black')
  })
  it('renders one list item per tick and survives an empty list', () => {
    expect(renderToStaticMarkup(<OfferPanel offer={offer} />).match(/<li/g)).toHaveLength(2)
    expect(renderToStaticMarkup(<OfferPanel offer={{ ...offer, ticks: [] }} />)).not.toContain('<li')
  })
  it('skips blank ticks without renumbering the ones after them', () => {
    // offerOf hands us a position-preserving array; a blank must not
    // render, and must not shift the index the surviving ticks carry,
    // because that index is the inline editor's write target.
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, ticks: ['', 'alpha', 'beta'] }} />)
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
  })
  it('hides the struck price from screen readers and keeps the note audible', () => {
    // Both are load-bearing: without aria-hidden the price is read
    // twice, and without sr-only the note becomes visible body text.
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('sr-only')
  })
  it('renders the CTA as the inverted pill so it is legible on the white panel', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('lp-btn-invert')
  })
})
