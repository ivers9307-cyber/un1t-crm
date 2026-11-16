// OFFERSPOLISH.1 — the markup the /offers accessibility fixes rest on, read
// from the server render (what a phone or a screen reader receives first)
// and from the stylesheet itself.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/revolut-embed', () => ({ loadRevolutSdk: vi.fn(), revolutMode: () => 'sandbox', revolutPublicKey: () => 'pk' }))

import OfferCheckout from './OfferCheckout'
import OfferMarquee from './OfferMarquee'

const css = readFileSync(new URL('../../app/offers/offers.css', import.meta.url), 'utf8')
const TERMS = { required: true, label: 'I accept the {terms} and {waiver}', terms_link_label: 'terms', waiver_link_label: 'waiver', terms_url: '/t', waiver_url: '/w' }

describe('offers checkout form', () => {
  const html = renderToStaticMarkup(<OfferCheckout studio="hatch-street" slug="x" priceLabel="€627" provider="un1t_online" terms={TERMS} />)

  // Attribute order is the renderer's business: read each tag on its own.
  const tag = (id) => html.match(new RegExp(`<input id="${id}"[^>]*>`))[0]

  it('names every field and tells the keyboard what it holds', () => {
    expect(tag('ofr-name')).toContain('name="name"')
    expect(tag('ofr-name')).toContain('autoComplete="name"')
    expect(tag('ofr-email')).toContain('name="email"')
    expect(tag('ofr-email')).toContain('autoCapitalize="none"')
    expect(tag('ofr-email')).toContain('spellCheck="false"')
    expect(tag('ofr-phone')).toContain('name="tel"')
    for (const id of ['ofr-name', 'ofr-email', 'ofr-phone']) expect(tag(id)).toMatch(/enterKeyHint="(next|go)"/)
  })

  it('ties the terms tick to its label by id', () => {
    expect(html).toContain('<label for="ofr-terms"')
    expect(tag('ofr-terms')).toContain('name="terms_accepted"')
    expect(tag('ofr-terms')).not.toContain('aria-invalid')
  })

  it('never renders a field under 16px, which iOS Safari zooms into', () => {
    const rule = css.match(/\.ofr-input \{[^}]*\}/)[0]
    expect(rule).toContain('font-size: max(16px, 1rem)')
    expect(rule).not.toMatch(/font-size: 1[0-5]px/)
  })
})

describe('offers marquee', () => {
  const html = renderToStaticMarkup(<OfferMarquee text="HEAD START · " />)

  it('hides the repeated words but not the pause button', () => {
    expect(html).toMatch(/^<div class="ofr-strip" data-paused="false">/)
    expect(html).toContain('<span aria-hidden="true">HEAD START · </span>')
    expect(html).toMatch(/<button type="button" class="ofr-strip-toggle" aria-label="Pause the scrolling banner">/)
  })

  it('moves only for people who have not asked for reduced motion', () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/, '')
    expect(outside).not.toMatch(/animation: ofr-slide/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*animation: ofr-slide 18s linear infinite/)
    expect(css).toMatch(/\.ofr-strip\[data-paused="true"\] > span \{ animation-play-state: paused; \}/)
  })
})
