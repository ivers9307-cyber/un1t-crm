// @vitest-environment jsdom
// HubTabs — the phase-2 hub tab strip. Contract: server layouts pass
// permission-filtered tabs; the strip owns active state (longest match),
// badge polling, and hides entirely when fewer than 2 tabs remain.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react'

const mockPathname = vi.fn(() => '/pipeline')
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname() }))
vi.mock('./use-polled-count', () => ({ usePolledCount: vi.fn(() => 0) }))

import HubTabs from './HubTabs.jsx'
import { usePolledCount } from './use-polled-count'

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts' },
  { id: 'tasks',    label: 'Tasks',    href: '/activities' },
]

afterEach(cleanup)

describe('HubTabs', () => {
  it('renders a link per tab with the given hrefs', () => {
    mockPathname.mockReturnValue('/pipeline')
    render(<HubTabs tabs={TABS} />)
    const links = screen.getAllByRole('link')
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/pipeline', '/contacts', '/activities'])
  })

  it('marks the longest matching tab active, not every prefix match', () => {
    mockPathname.mockReturnValue('/contacts/abc123')
    render(<HubTabs tabs={TABS} />)
    const active = screen.getAllByRole('link').filter(l => l.className.includes('font-semibold'))
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toContain('Contacts')
  })

  it('renders nothing with fewer than 2 tabs', () => {
    const { container } = render(<HubTabs tabs={[TABS[0]]} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows a badge only when the polled count is positive, capped at 99+', () => {
    usePolledCount.mockReturnValueOnce(120)
    render(<HubTabs tabs={[{ ...TABS[0], badgeUrl: '/api/x/count' }, TABS[1]]} />)
    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('polls only tabs that declare a badgeUrl', () => {
    usePolledCount.mockClear()
    render(<HubTabs tabs={TABS} />)
    expect(usePolledCount).not.toHaveBeenCalled()
  })

  // HUBS.2d review — the (team) group wraps the /contracts/[id] print/
  // "Save as PDF" surface, and nav chrome printed onto the legal
  // document. print:hidden on the root element is the load-bearing fix.
  it('never prints — root element carries print:hidden', () => {
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
    expect(container.firstChild.className).toContain('print:hidden')
  })
})

// COMMS-DETAIL-FIX.2 — ported from CommunicationsTabs.test.jsx (the origin
// of this scroller/fade implementation). It was a real production defect —
// a scrollable strip with the scrollbar hidden and zero signal that more
// tabs existed, plus scrollIntoView parking the active tab so its edge cut
// straight through a badge. Every hub layout reuses this file, so the
// overflow affordance gets its own direct coverage here rather than
// inheriting CommunicationsTabs' guarantee.
function measurable(el, { scrollWidth, clientWidth, scrollLeft }) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft, writable: true, configurable: true })
}

describe('HubTabs — overflow affordance (COMMS-DETAIL-FIX.2)', () => {
  it('shows no fade on desktop, where the row fits', () => {
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 768, clientWidth: 768, scrollLeft: 0 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).queryByTestId('tabs-fade-start')).toBeNull()
    expect(within(container).queryByTestId('tabs-fade-end')).toBeNull()
  })

  it('fades only the trailing edge at the start of an overflowing strip', () => {
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    measurable(scroller, { scrollWidth: 507, clientWidth: 327, scrollLeft: 0 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).queryByTestId('tabs-fade-start')).toBeNull()
    expect(within(container).getByTestId('tabs-fade-end')).toBeTruthy()
  })

  it('fades the leading edge once the row is scrolled — the severed-badge case', () => {
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
    const scroller = within(container).getByTestId('tabs-scroller')
    // Same measured "scrolled fully right" state as the CommunicationsTabs case.
    measurable(scroller, { scrollWidth: 507, clientWidth: 327, scrollLeft: 180 })
    act(() => { fireEvent.scroll(scroller) })
    expect(within(container).getByTestId('tabs-fade-start')).toBeTruthy()
    expect(within(container).queryByTestId('tabs-fade-end')).toBeNull()
  })

  it('keeps the fades out of the accessibility tree and out of the way of taps', () => {
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
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
    mockPathname.mockReturnValue('/pipeline')
    const { container } = render(<HubTabs tabs={TABS} />)
    expect(within(container).getByTestId('tabs-scroller').className).toMatch(/scroll-p[xl]?-/)
  })
})

// HUBS.2f Task 2 — a hub tab that points at an external/public page
// (the Marketing hub's Landing page tab → /welcome, the public site)
// renders as a plain new-tab anchor instead of an in-app <Link>, the
// same idiom the sidebar already uses for openInNewTab entries
// (Sidebar.jsx SidebarItem). External pages have no in-app pathname,
// so they can never be usePathname's match — active-state computation
// excludes them outright rather than relying on them simply never
// matching.
describe('HubTabs — newTab capability (HUBS.2f)', () => {
  const NEWTAB_TABS = [
    { id: 'automations', label: 'Automations', href: '/automations' },
    { id: 'landing',     label: 'Landing page', href: '/welcome', newTab: true },
  ]

  it('renders a newTab tab as target="_blank" with rel="noopener noreferrer", not a Link', () => {
    mockPathname.mockReturnValue('/automations')
    render(<HubTabs tabs={NEWTAB_TABS} />)
    const links = screen.getAllByRole('link')
    const landing = links.find(l => l.textContent.includes('Landing page'))
    expect(landing.getAttribute('href')).toBe('/welcome')
    expect(landing.getAttribute('target')).toBe('_blank')
    expect(landing.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('never marks a newTab tab active, even when the pathname matches its href', () => {
    // /welcome is never a real in-app pathname, but even a contrived
    // match must not light the external tab.
    mockPathname.mockReturnValue('/welcome')
    render(<HubTabs tabs={NEWTAB_TABS} />)
    const active = screen.getAllByRole('link').filter(l => l.className.includes('font-semibold'))
    expect(active).toHaveLength(0)
  })

  it('counts a newTab tab toward the >=2 visibility threshold', () => {
    mockPathname.mockReturnValue('/automations')
    const { container } = render(<HubTabs tabs={NEWTAB_TABS} />)
    expect(container.innerHTML).not.toBe('')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
})
