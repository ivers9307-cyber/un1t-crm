// HEROHEADER.1/.2 — the fixed header is black glass on every page, caps the
// logo's height, and can drop its button (OneClassLayout: the booking card is the CTA).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeader } from './BlockRenderers'
import { OneClassLayout, FrostedCardLayout } from './PageLayout'

const LOGO = 'https://cdn/logo.png'

describe('SiteHeader bar', () => {
  it('is the black glass bar on every page, a light page included (HEROHEADER.2)', () => {
    for (const props of [{}, { tone: 'light' }]) {
      const html = renderToStaticMarkup(<SiteHeader sticky {...props} wordmark="GA" eventsHref="/x/events" ctaHref="#book" ctaLabel="Book" />)
      expect(html).toContain('bg-black/55')
      expect(html).not.toContain('bg-white/80')
      expect(html).toContain('tracking-widest text-white">GA</div>')
    }
  })

  it('caps the logo at 48px tall as well as 170px wide', () => {
    const html = renderToStaticMarkup(<SiteHeader sticky logoUrl={LOGO} logoWidthPx={150} />)
    expect(html).toContain('max-width:150px')
    expect(html).toContain('max-height:48px')
    expect(html).toContain('width:auto')
  })
})

describe('layout headers', () => {
  const shared = { logo: { url: LOGO, alt: 'UN1T' }, cta: { href: '#book', label: 'Book a free class' }, footer: {}, blocks: [], blockProps: {} }

  it('OneClassLayout renders the black header with no header button; the footer CTA stays', () => {
    const html = renderToStaticMarkup(
      <OneClassLayout {...shared} tone="light" hero={{ heading: 'H' }} expect={{ cards: [] }} offer={<p>card</p>} />,
    )
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toContain('bg-black/55')
    expect(header).not.toContain('Book a free class')
    expect(html.slice(html.indexOf('</header>'))).toContain('Book a free class')
  })

  it('FrostedCardLayout keeps its header button', () => {
    const html = renderToStaticMarkup(<FrostedCardLayout {...shared} tone="dark" offer={<p>card</p>} />)
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toContain('Book a free class')
    expect(header).toContain('bg-black/55')
  })
})
