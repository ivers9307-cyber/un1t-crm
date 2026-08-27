// @vitest-environment jsdom
//
// COMMSLAYOUT.2 — six `flex-1` tabs in a no-wrap, no-scroll row squash to
// unreadable at 375px. The row scrolls horizontally on narrow screens and
// keeps the even-width desktop layout via `min-w-full` + `flex-1`.
//
// DEEP.4 Task 2 (4B) — this component slimmed from six tabs to two: Send /
// Sent / Templates / Segments moved to communications/(marketing-era) (see
// that layout's header comment). What's left is Inbox + Email inbox, so
// this file's fixtures and assertions shrink to match — the scroller/fade/
// badge behaviour underneath is unchanged and still worth pinning at two
// tabs (a narrow viewport can still overflow with badges attached).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react'

const { polled } = vi.hoisted(() => ({ polled: vi.fn(() => 0) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/communications/tickets' }))
vi.mock('../use-polled-count', () => ({ usePolledCount: (...args) => polled(...args) }))

import CommunicationsTabs from './CommunicationsTabs.jsx'

const ALL = { canWhatsapp: true, canEmailInbox: true }

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
  it('renders both tabs when both permissions are held', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const labels = within(container).getAllByRole('link').map((a) => a.textContent)
    expect(labels).toEqual(['WhatsApp & Instagram inbox', 'Email inbox'])
  })

  it('renders only Inbox when canEmailInbox is false', () => {
    render(<CommunicationsTabs canWhatsapp canEmailInbox={false} />)
    expect(screen.getByRole('link', { name: /^WhatsApp & Instagram inbox$/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /^Email inbox$/ })).toBeNull()
  })

  it('renders only Email inbox when canWhatsapp is false', () => {
    render(<CommunicationsTabs canWhatsapp={false} canEmailInbox />)
    expect(screen.queryByRole('link', { name: /^WhatsApp & Instagram inbox$/ })).toBeNull()
    expect(screen.getByRole('link', { name: /^Email inbox$/ })).toBeTruthy()
  })

  it('renders nothing when neither permission is held', () => {
    const { container } = render(<CommunicationsTabs canWhatsapp={false} canEmailInbox={false} />)
    expect(within(container).queryAllByRole('link')).toHaveLength(0)
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
    const active = within(container).getByRole('link', { name: /^Email inbox$/ })
    expect(active.className).toContain('bg-un1t-text')
    expect(active.className).toContain('text-un1t-bg')
    const inactive = within(container).getByRole('link', { name: /^WhatsApp & Instagram inbox$/ })
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
    expect(within(container).getByRole('link', { name: /WhatsApp & Instagram inbox/ }).textContent).toContain('7')
  })

  it('still renders a badge on the Email inbox tab', () => {
    polled.mockImplementation(({ url }) => (url.includes('tickets') ? 3 : 0))
    const { container } = render(<CommunicationsTabs {...ALL} />)
    expect(within(container).getByRole('link', { name: /Email inbox/ }).textContent).toContain('3')
  })
})

// COMMS-DETAIL-FIX.2 — at 375px the strip could be wider than the viewport,
// the scrollbar is hidden ([scrollbar-width:none]) and there was no fade,
// shadow or arrow. So there was ZERO signal that more tabs existed — and
// with the last tab active, scrollIntoView parked the row so the left edge
// cut straight through a badge, leaving a red half-circle with a hard
// vertical edge and no label. That reads as a rendering bug, not "scroll for
// more". Both halves are fixed here: a gradient fade on whichever edge has
// content beyond it, and scroll-padding so the resting position leaves a
// readable sliver instead of slicing an element down the middle. Still
// worth pinning at two tabs — a narrow viewport + a wide badge can overflow
// even a short row.
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
    measurable(scroller, { scrollWidth: 400, clientWidth: 250, scrollLeft: 0 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).queryByTestId('tabs-fade-start')).toBeNull()
    expect(within(container).getByTestId('tabs-fade-end')).toBeTruthy()
  })

  it('fades the leading edge once the row is scrolled — the severed-badge case', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 400, clientWidth: 250, scrollLeft: 150 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).getByTestId('tabs-fade-start')).toBeTruthy()
    expect(within(container).queryByTestId('tabs-fade-end')).toBeNull()
  })

  it('keeps the fades out of the accessibility tree and out of the way of taps', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 400, clientWidth: 250, scrollLeft: 60 })
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

// FU-COMMSTABS-BAILOUT — backports HubTabs.jsx's measure() functional-
// setState bail-out (`setEdges(prev => same values ? prev : next)`) to
// this component's identical pattern. jsdom always reports
// scrollWidth === clientWidth === 0, so on mount BOTH the mount
// useLayoutEffect's measure() call and the [pathname, measure] mount
// useEffect's measure() call compute the same {start:false,end:false} —
// matching the initial state's values too. Before the bail-out, each
// call handed setEdges a FRESH object literal, and React only skips a
// re-render on reference equality, not value equality, so both calls
// forced a spurious extra render — which re-invoked every poller hook
// in the component body (usePolledCount for inbox + email counts here),
// discarding whatever the first render's poll saw. `polled` (the mocked
// usePolledCount) is called exactly twice per render (once per badge),
// so counting its total calls after mount pins the render count.
describe('CommunicationsTabs — measure() re-render bail-out (FU-COMMSTABS-BAILOUT)', () => {
  it('does not spuriously re-render on mount when the measured edges already match initial state', () => {
    render(<CommunicationsTabs {...ALL} />)
    // One render's worth of poller calls (inbox + email) — not 4 or 6,
    // which is what stacking the layout-effect and mount-effect measure()
    // calls on top of the initial render would produce without the bail-out.
    expect(polled.mock.calls.length).toBe(2)
  })
})

// INBOX-SURFACE.C — the Mail tab, and the reason it is DATA-gated.
//
// /communications/mail lists the accounts whose email_mailboxes.surface is
// 'inbox' and nothing else. A studio that has moved none has nothing there, so
// the tab must not appear: an operator who clicks an empty surface concludes
// their mail is missing, not that a trial is off for them. An empty surface in
// the nav is worse than no surface.
//
// The gate is resolved in the hub layout (it needs a query) and arrives here as
// a boolean, so what this file pins is that the boolean is honoured and that
// nothing about it is inferred from a permission.
describe('CommunicationsTabs — the Mail surface (INBOX-SURFACE.C)', () => {
  it('is ABSENT by default — a studio not in the trial sees the two tabs it had', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const labels = within(container).getAllByRole('link').map(a => a.textContent)
    expect(labels).toEqual(['WhatsApp & Instagram inbox', 'Email inbox'])
  })

  it('is absent when canMail is false, even holding the email_inbox key', () => {
    // The permission is not the gate. Someone who works the queue every day at
    // a studio with nothing moved must not be shown an empty surface.
    render(<CommunicationsTabs canWhatsapp={false} canEmailInbox canMail={false} />)
    expect(screen.queryByRole('link', { name: /^Mail$/ })).toBeNull()
  })

  it('appears when the location has an account on that surface', () => {
    render(<CommunicationsTabs {...ALL} canMail />)
    const tab = screen.getByRole('link', { name: /^Mail$/ })
    // NOT /communications/inbox — that is the WhatsApp + Instagram queue, whose
    // tab is rendered right beside this one.
    expect(tab.getAttribute('href')).toBe('/communications/mail')
  })

  it('is labelled Mail, not Inbox — two tabs called Inbox is a guess', () => {
    const { container } = render(<CommunicationsTabs {...ALL} canMail />)
    const labels = within(container).getAllByRole('link').map(a => a.textContent)
    expect(labels).toEqual(['WhatsApp & Instagram inbox', 'Email inbox', 'Mail'])
  })

  it('carries no badge — the needs-reply count belongs to the ticket surface', () => {
    // Reusing that number here would put one count on two tabs holding
    // different mail, and a badge with nothing behind it is one an operator
    // learns to ignore.
    polled.mockReturnValue(7)
    render(<CommunicationsTabs canWhatsapp={false} canEmailInbox canMail />)
    expect(screen.getByRole('link', { name: /^Mail$/ }).textContent).toBe('Mail')
    expect(screen.getByRole('link', { name: /Email inbox/ }).textContent).toContain('7')
  })
})
