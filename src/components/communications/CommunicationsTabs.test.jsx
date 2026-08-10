// @vitest-environment jsdom
//
// COMMSLAYOUT.2 / .3 — two defects in one strip:
//
//  .2  Six `flex-1` tabs in a no-wrap, no-scroll row squash to unreadable at
//      375px. The row now scrolls horizontally on narrow screens and keeps the
//      even-width desktop layout via `min-w-full` + `flex-1`.
//  COMMS-IA.3 renamed two of the six labels: "Sends" → "Sent" (the route was
//      always /communications/sent) and "Email" → "Email inbox". The label
//      list below is the guard that both landed.
//  .3  The Segments tab used to render on `canEmail || canWhatsapp` while
//      /communications/segments itself is manager-gated, so a `staff` user with
//      the email permission was ejected to `/`. The tab now takes its own
//      `canSegments` prop and simply is not rendered for them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react'

const { polled } = vi.hoisted(() => ({ polled: vi.fn(() => 0) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/communications/sent' }))
vi.mock('../use-polled-count', () => ({ usePolledCount: (...args) => polled(...args) }))

import CommunicationsTabs from './CommunicationsTabs.jsx'

const ALL = {
  canSms: true, canEmail: true, canWhatsapp: true,
  canEmailInbox: true, canSegments: true,
}

beforeEach(() => {
  cleanup()
  polled.mockReset()
  polled.mockReturnValue(0)
})
afterEach(() => cleanup())

function strip(container) {
  // The scroll viewport wraps the row; the row itself is the flex container.
  const row = container.querySelector('.flex')
  return { row, scroller: row.parentElement }
}

describe('CommunicationsTabs — 375px survivability (COMMSLAYOUT.2)', () => {
  it('renders all six tabs when every permission is held', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const labels = within(container).getAllByRole('link').map((a) => a.textContent)
    expect(labels).toEqual(['Send', 'Sent', 'Inbox', 'Email inbox', 'Templates', 'Segments'])
  })

  it('puts the row in a horizontal scroll container', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const { scroller } = strip(container)
    expect(scroller.className).toContain('overflow-x-auto')
  })

  it('never wraps or truncates a tab label — the row grows and scrolls instead', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const { row } = strip(container)
    // w-max lets the row exceed the viewport at 375px…
    expect(row.className).toContain('w-max')
    // …and min-w-full keeps it filling the strip on desktop.
    expect(row.className).toContain('min-w-full')
    for (const a of within(container).getAllByRole('link')) {
      expect(a.className).toContain('whitespace-nowrap')
    }
  })

  it('keeps the even-width desktop row: every tab still flex-1', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    for (const a of within(container).getAllByRole('link')) {
      expect(a.className).toContain('flex-1')
    }
  })

  it('keeps the active-state styling', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const active = within(container).getByRole('link', { name: /^Sent$/ })
    expect(active.className).toContain('bg-un1t-text')
    expect(active.className).toContain('text-un1t-bg')
    const inactive = within(container).getByRole('link', { name: /^Templates$/ })
    expect(inactive.className).toContain('text-un1t-subtle')
  })

  it('scrolls the active tab into view without moving the page vertically', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    render(<CommunicationsTabs {...ALL} />)
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][0]).toMatchObject({ block: 'nearest', inline: 'nearest' })
    delete Element.prototype.scrollIntoView
  })
})

describe('CommunicationsTabs — badges survive the layout change', () => {
  it('still renders a badge on a tab that has a count', () => {
    polled.mockImplementation(({ url }) => (url.includes('whatsapp') ? 7 : 0))
    const { container } = render(<CommunicationsTabs {...ALL} />)
    expect(within(container).getByRole('link', { name: /Inbox/ }).textContent).toContain('7')
  })
})

describe('CommunicationsTabs — Segments gate (COMMSLAYOUT.3)', () => {
  it('hides Segments when the viewer cannot open the segments page', () => {
    render(<CommunicationsTabs {...ALL} canSegments={false} />)
    expect(screen.queryByRole('link', { name: /^Segments$/ })).toBeNull()
  })

  it('shows Segments when the viewer passes the page gate', () => {
    render(<CommunicationsTabs {...ALL} canSegments />)
    expect(screen.getByRole('link', { name: /^Segments$/ })).toBeTruthy()
  })

  it('does not show Segments on channel permission alone', () => {
    render(<CommunicationsTabs canEmail canWhatsapp canSegments={false} />)
    expect(screen.queryByRole('link', { name: /^Segments$/ })).toBeNull()
  })
})

// COMMS-DETAIL-FIX.2 — at 375px the strip is 507px of content in a 327px
// viewport, the scrollbar is hidden ([scrollbar-width:none]) and there was no
// fade, shadow or arrow. So there was ZERO signal that more tabs existed —
// and with the last tab active, scrollIntoView parked the row so the left edge
// cut straight through the Inbox badge, leaving a red half-circle with a hard
// vertical edge and no label. That reads as a rendering bug, not "scroll for
// more". Both halves are fixed here: a gradient fade on whichever edge has
// content beyond it, and scroll-padding so the resting position leaves a
// readable sliver instead of slicing an element down the middle.
function measurable(el, { scrollWidth, clientWidth, scrollLeft }) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft, writable: true, configurable: true })
}

describe('CommunicationsTabs — overflow affordance (COMMS-DETAIL-FIX.2)', () => {
  it('shows no fade on desktop, where the row fits', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 768, clientWidth: 768, scrollLeft: 0 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).queryByTestId('tabs-fade-start')).toBeNull()
    expect(within(container).queryByTestId('tabs-fade-end')).toBeNull()
  })

  it('fades only the trailing edge at the start of an overflowing strip', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 507, clientWidth: 327, scrollLeft: 0 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).queryByTestId('tabs-fade-start')).toBeNull()
    expect(within(container).getByTestId('tabs-fade-end')).toBeTruthy()
  })

  it('fades the leading edge once the row is scrolled — the severed-badge case', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    // Exactly the measured 375px "Segments active" state: scrolled fully right.
    measurable(scroller, { scrollWidth: 507, clientWidth: 327, scrollLeft: 180 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).getByTestId('tabs-fade-start')).toBeTruthy()
    expect(within(container).queryByTestId('tabs-fade-end')).toBeNull()
  })

  it('keeps the fades out of the accessibility tree and out of the way of taps', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 507, clientWidth: 327, scrollLeft: 90 })
    act(() => { fireEvent.scroll(scroller) })
    for (const id of ['tabs-fade-start', 'tabs-fade-end']) {
      const fade = within(container).getByTestId(id)
      expect(fade.getAttribute('aria-hidden')).toBe('true')
      expect(fade.className).toContain('pointer-events-none')
    }
  })

  it('leaves scroll padding so a resting scroll never slices a tab down the middle', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    expect(within(container).getByTestId('tabs-scroller').className).toMatch(/scroll-p[xl]?-/)
  })
})
