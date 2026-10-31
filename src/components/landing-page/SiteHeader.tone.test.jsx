// HEROHEADER.1 — the fixed header follows the page tone, caps the logo's
// height, and can drop its button (OneClassLayout: the booking card is the CTA).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeader } from './BlockRenderers'
import { OneClassLayout, FrostedCardLayout } from './PageLayout'

const LOGO = 'https://cdn/logo.png'

describe('SiteHeader tone', () => {
  it('dark (the default) is the black glass bar it always was', () => {
    const html = renderToStaticMarkup(<SiteHeader sticky logoUrl={LOGO} ctaHref="#book" ctaLabel="Book" />)
    expect(html).toContain('bg-black/55')
    expect(html).not.toContain('bg-white/80')
  })

  it('light is white glass with dark text, Events included', () => {
    const html = renderToStaticMarkup(<SiteHeader sticky tone="light" wordmark="GA" eventsHref="/x/events" ctaHref="#book" ctaLabel="Book" />)
    expect(html).toContain('bg-white/80')
    expect(html).toContain('border-black/10')
    expect(html).toContain('tracking-widest text-black">GA</div>')
    expect(html).toContain('text-black/70')
    expect(html).not.toContain('bg-black/55')
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

  it('OneClassLayout renders a light header with no header button; the footer CTA stays', () => {
    const html = renderToStaticMarkup(
      <OneClassLayout {...shared} tone="light" hero={{ heading: 'H' }} expect={{ cards: [] }} offer={<p>card</p>} />,
    )
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toContain('bg-white/80')
    expect(header).not.toContain('Book a free class')
    expect(html.slice(html.indexOf('</header>'))).toContain('Book a free class')
  })

  it('FrostedCardLayout keeps its header button and takes the page tone', () => {
    const html = renderToStaticMarkup(<FrostedCardLayout {...shared} tone="dark" offer={<p>card</p>} />)
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toContain('Book a free class')
    expect(header).toContain('bg-black/55')
  })
})
