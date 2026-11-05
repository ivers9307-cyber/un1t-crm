// @vitest-environment jsdom
//
// MOBILEFUNNEL.1 — the phone's bottom button back to the offer card: shown
// only while the card is out of view, labelled with the page's CTA, and on
// the one_class layout only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import StickyOfferBar, { anchorIdOf } from './StickyOfferBar'
import { OneClassLayout, FrostedCardLayout, BlocksLayout } from './PageLayout'

let observers
class FakeIO {
  constructor(cb) { this.cb = cb; this.targets = []; observers.push(this) }
  observe(el) { this.targets.push(el) }
  disconnect() { this.disconnected = true }
}
async function cardVisible(visible) {
  await act(async () => {
    for (const o of observers) o.cb(o.targets.map((target) => ({ target, isIntersecting: visible })))
  })
}

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mountWithCard(props = {}) {
  return render(
    <>
      <div id="corp">card</div>
      <StickyOfferBar href="#corp" label="Claim my 3 free classes" {...props} />
    </>,
  )
}
const bar = () => document.querySelector('[data-sticky-offer]')

describe('StickyOfferBar', () => {
  it('watches the card the anchor names and shows the bar only while the card is out of view', async () => {
    mountWithCard()
    expect(observers).toHaveLength(1)
    expect(observers[0].targets[0].id).toBe('corp')
    expect(bar()).toBeNull() // nothing until the observer has spoken
    await cardVisible(false)
    const link = screen.getByRole('link', { name: 'Claim my 3 free classes' })
    expect(link.getAttribute('href')).toBe('#corp')
    expect(bar().className).toContain('lg:hidden')
    expect(bar().getAttribute('style')).toContain('safe-area-inset-bottom')
    await cardVisible(true)
    expect(bar()).toBeNull()
    await cardVisible(false)
    expect(bar()).not.toBeNull()
  })

  it('the tap scrolls the card to just under the header, smoothly unless reduced motion', async () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    mountWithCard()
    document.getElementById('corp').getBoundingClientRect = () => ({ top: -500 })
    window.scrollY = 1500
    await cardVisible(false)
    fireEvent.click(screen.getByRole('link', { name: 'Claim my 3 free classes' }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 928, behavior: 'smooth' })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    fireEvent.click(screen.getByRole('link', { name: 'Claim my 3 free classes' }))
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 928, behavior: 'auto' })
  })

  it('never shows with no card at the anchor, no anchor, no label or no IntersectionObserver', async () => {
    render(<StickyOfferBar href="#missing" label="Claim" />)
    expect(observers).toHaveLength(0)
    cleanup()
    expect(renderToStaticMarkup(<StickyOfferBar href={null} label="Claim" />)).toBe('')
    expect(renderToStaticMarkup(<StickyOfferBar href="#corp" label="" />)).toBe('')
    vi.stubGlobal('IntersectionObserver', undefined)
    mountWithCard()
    expect(bar()).toBeNull()
  })

  it('anchorIdOf takes only an in-page anchor', () => {
    expect(anchorIdOf('#book')).toBe('book')
    expect(anchorIdOf('#')).toBeNull()
    expect(anchorIdOf('/trial')).toBeNull()
    expect(anchorIdOf(null)).toBeNull()
  })
})

describe('layouts', () => {
  const shared = { logo: { url: null, wordmark: 'UN1T' }, cta: { href: '#corp', label: 'Claim my 3 free classes' }, footer: {}, blocks: [], blockProps: {} }
  it('OneClassLayout mounts the bar with the page CTA; the frosted and blocks layouts do not', async () => {
    render(<OneClassLayout {...shared} hero={{ heading: 'H' }} expect={{ cards: [] }} offer={<div id="corp">card</div>} />)
    expect(observers.some((o) => o.targets.some((t) => t.id === 'corp'))).toBe(true)
    await cardVisible(false)
    expect(bar().textContent).toBe('Claim my 3 free classes')
    cleanup()
    observers = []
    render(<FrostedCardLayout {...shared} offer={<div id="corp">card</div>} />)
    await cardVisible(false)
    expect(bar()).toBeNull()
    cleanup()
    render(<BlocksLayout {...shared} />)
    expect(bar()).toBeNull()
  })
})

