// @vitest-environment jsdom
//
// COMMSLAYOUT.2 — six `flex-1` tabs in a no-wrap, no-scroll row squash to
// unreadable at 375px. The row scrolls horizontally on narrow screens and
// keeps the even-width desktop layout via `min-w-full` + `flex-1`.
//
// DEEP.4 Task 2 (4B) slimmed this component from six tabs to two;
// RETIRE-TICKETS.1 then retired the "Email inbox" ticket-queue tab, so the
// two tabs are the WhatsApp/Instagram inbox and Mail. The scroller/fade/
// badge behaviour underneath is unchanged and still worth pinning at two
// tabs (a narrow viewport can still overflow with badges attached).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react'

const { polled } = vi.hoisted(() => ({ polled: vi.fn(() => 0) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/communications/mail' }))
vi.mock('../use-polled-count', () => ({ usePolledCount: (...args) => polled(...args) }))

import CommunicationsTabs from './CommunicationsTabs.jsx'

const ALL = { canWhatsapp: true, canMail: true }

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
    expect(labels).toEqual(['WhatsApp & Instagram inbox', 'Mail'])
  })

  it('renders only Inbox when canMail is false', () => {
    render(<CommunicationsTabs canWhatsapp canMail={false} />)
    expect(screen.getByRole('link', { name: /^WhatsApp & Instagram inbox$/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /^Mail$/ })).toBeNull()
  })

  it('renders only Mail when canWhatsapp is false', () => {
    render(<CommunicationsTabs canWhatsapp={false} canMail />)
    expect(screen.queryByRole('link', { name: /^WhatsApp & Instagram inbox$/ })).toBeNull()
    expect(screen.getByRole('link', { name: /^Mail$/ })).toBeTruthy()
  })

  it('renders nothing when neither gate is open', () => {
    const { container } = render(<CommunicationsTabs canWhatsapp={false} canMail={false} />)
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
    const active = within(container).getByRole('link', { name: /^Mail$/ })
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

  it('still renders a badge on the Mail tab', () => {
    polled.mockImplementation(({ url }) => (url.includes('mail') ? 3 : 0))
    const { container } = render(<CommunicationsTabs {...ALL} />)
    expect(within(container).getByRole('link', { name: /Mail/ }).textContent).toContain('3')
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
// usePolledCount) is called exactly three times per render now
// (INBOX-SURFACE.E added the Mail tab's own poller alongside inbox +
// tickets — the hook is called unconditionally regardless of `canMail`,
// just with `enabled: false` when there is nothing to poll), so counting
// its total calls after mount still pins the render count.
describe('CommunicationsTabs — measure() re-render bail-out (FU-COMMSTABS-BAILOUT)', () => {
  it('does not spuriously re-render on mount when the measured edges already match initial state', () => {
    render(<CommunicationsTabs {...ALL} />)
    // One render's worth of poller calls (inbox + mail) — not 4 or 6, which
    // is what stacking the layout-effect and mount-effect measure() calls on
    // top of the initial render would produce without the bail-out.
    expect(polled.mock.calls.length).toBe(2)
  })
})

// INBOX-SURFACE.C — the Mail tab, and the reason it is DATA-gated.
//
// The gate arrives from the hub layout as a boolean ("does this studio hold
// any active email account"): a studio with none has nothing for the tab to
// show, and an operator who clicks an empty surface concludes their mail is
// missing. What this file pins is that the boolean is honoured and that
// nothing about it is inferred from a permission.
describe('CommunicationsTabs — the Mail tab (INBOX-SURFACE.C / RETIRE-TICKETS.1)', () => {
  it('is absent when canMail is false — no email tab renders at all', () => {
    render(<CommunicationsTabs canWhatsapp={false} canMail={false} />)
    expect(screen.queryByRole('link', { name: /^Mail$/ })).toBeNull()
  })

  it('links /communications/mail — never the WhatsApp inbox', () => {
    render(<CommunicationsTabs {...ALL} />)
    const tab = screen.getByRole('link', { name: /^Mail$/ })
    expect(tab.getAttribute('href')).toBe('/communications/mail')
  })

  it('is labelled Mail, not Inbox — two tabs called Inbox is a guess', () => {
    const { container } = render(<CommunicationsTabs {...ALL} />)
    const labels = within(container).getAllByRole('link').map(a => a.textContent)
    expect(labels).toEqual(['WhatsApp & Instagram inbox', 'Mail'])
  })

  it('polls its own endpoint and renders the count as a badge', () => {
    polled.mockImplementation(({ url }) => (url === '/api/email/mail/count' ? 4 : 0))
    render(<CommunicationsTabs canWhatsapp={false} canMail />)
    expect(screen.getByRole('link', { name: /Mail/ }).textContent).toContain('4')
  })

  it('does not poll the mail count when canMail is false — nothing to act on', () => {
    render(<CommunicationsTabs canWhatsapp={false} canMail={false} />)
    const mailCountCalls = polled.mock.calls.filter(([opts]) => opts.url === '/api/email/mail/count')
    expect(mailCountCalls.length).toBeGreaterThan(0)
    for (const [opts] of mailCountCalls) {
      expect(opts.enabled).toBe(false)
    }
  })

  it('enables the mail-count poll once canMail is true', () => {
    render(<CommunicationsTabs canWhatsapp={false} canMail />)
    const mailCountCalls = polled.mock.calls.filter(([opts]) => opts.url === '/api/email/mail/count')
    expect(mailCountCalls.length).toBeGreaterThan(0)
    for (const [opts] of mailCountCalls) {
      expect(opts.enabled).toBe(true)
    }
  })

  it('renders no badge on the Mail tab when its count is zero', () => {
    polled.mockReturnValue(0)
    render(<CommunicationsTabs canWhatsapp={false} canMail />)
    expect(screen.getByRole('link', { name: /^Mail$/ }).textContent).toBe('Mail')
  })
})
