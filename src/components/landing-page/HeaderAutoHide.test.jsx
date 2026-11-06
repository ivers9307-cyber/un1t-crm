// @vitest-environment jsdom
//
// MOBILEFUNNEL.1 — the sticky header on a phone: slim, slides away while the
// visitor scrolls down, back while they scroll up; never at the top, never
// from `lg`, never under reduced motion.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeader } from './BlockRenderers'
import { nextHidden, PHONE_QUERY, REDUCED_MOTION_QUERY } from './HeaderAutoHide'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('nextHidden', () => {
  const base = { barHeight: 56, allowed: true }
  it('hides on a scroll down past the bar, shows on a scroll up, holds inside the deadband', () => {
    expect(nextHidden({ ...base, y: 400, lastY: 300 })).toBe(true)
    expect(nextHidden({ ...base, y: 300, lastY: 400 })).toBe(false)
    expect(nextHidden({ ...base, y: 403, lastY: 400 })).toBeNull()
  })
  it('never hides at the very top, or when not allowed (wide screen, reduced motion)', () => {
    expect(nextHidden({ ...base, y: 40, lastY: 0 })).toBe(false)
    expect(nextHidden({ ...base, allowed: false, y: 900, lastY: 300 })).toBe(false)
  })
})

function stubMedia({ phone = true, reduced = false } = {}) {
  vi.stubGlobal('matchMedia', (q) => ({ matches: q === PHONE_QUERY ? phone : q === REDUCED_MOTION_QUERY ? reduced : false }))
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
}
async function scrollTo(y) {
  await act(async () => {
    window.scrollY = y
    window.dispatchEvent(new Event('scroll'))
  })
}
const header = () => document.querySelector('header')

describe('SiteHeader auto-hide (sticky)', () => {
  it('slides away scrolling down, comes back scrolling up, and is shown again at the top', async () => {
    stubMedia()
    window.scrollY = 0
    render(<SiteHeader sticky wordmark="UN1T" ctaHref="#book" ctaLabel="Book" />)
    expect(header().getAttribute('data-hidden')).toBe('false')
    await scrollTo(300)
    expect(header().getAttribute('data-hidden')).toBe('true')
    await scrollTo(200)
    expect(header().getAttribute('data-hidden')).toBe('false')
    await scrollTo(600)
    expect(header().getAttribute('data-hidden')).toBe('true')
    await scrollTo(0)
    expect(header().getAttribute('data-hidden')).toBe('false')
  })

  it('stays put on a wide screen and under reduced motion', async () => {
    for (const media of [{ phone: false }, { reduced: true }]) {
      stubMedia(media)
      window.scrollY = 0
      render(<SiteHeader sticky wordmark="UN1T" />)
      await scrollTo(500)
      expect(header().getAttribute('data-hidden')).toBe('false')
      cleanup()
    }
  })

  it('the classes move it only below lg, with no transition under reduced motion; the bar is slim below lg', () => {
    const html = renderToStaticMarkup(<SiteHeader sticky logoUrl="https://cdn/logo.png" />)
    expect(html).toContain('max-lg:data-[hidden=true]:-translate-y-full')
    expect(html).toContain('motion-reduce:transition-none')
    expect(html).toContain('py-2 lg:py-4')
    expect(html).toContain('max-lg:!max-h-9')
  })

  it('the edit preview header (not sticky) has no auto-hide', () => {
    stubMedia()
    render(<SiteHeader wordmark="UN1T" />)
    expect(header().hasAttribute('data-hidden')).toBe(false)
    expect(header().className).not.toContain('translate-y-full')
  })
})
