// @vitest-environment jsdom
// HubTabs — the phase-2 hub tab strip. Contract: server layouts pass
// permission-filtered tabs; the strip owns active state (longest match),
// badge polling, and hides entirely when fewer than 2 tabs remain.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

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
})
