// @vitest-environment jsdom
//
// HUBS.2e Task 4 review fix (2026-08-15) — first render test for Sidebar.
// A group's parent row and its lit child row both used to satisfy
// aria-current, so a group-child page (e.g. /presentations/xyz)
// announced TWO "current pages" to a screen reader. Decision: keep the
// parent's visual active tint (section context is good UX), but
// aria-current="page" belongs ONLY on the element whose own href equals
// the winning matchedPath. This file pins "exactly one aria-current,
// always" so it can't silently regress again.
//
// HUBS.2e Task 5 update — the /presentations/xyz case below used to
// exercise the Studio Management GROUP (parent tint + child
// aria-current). Task 5 collapsed Studio Management into the single
// /operations leaf entry, so that same URL now resolves to one plain
// leaf item lighting both tint AND aria-current together (no group,
// no separate child row to split the two) — still exactly one
// aria-current, by construction rather than by the parent/child split.
//
// Mirrors HubTabs.test.jsx conventions (mockPathname + a mocked
// use-polled-count) plus the '@/lib/permissions' mock other component
// tests use to sidestep the real 3-tier resolver — this file is testing
// the sidebar's RENDER logic (active-state / aria-current), not the
// permission matrix, so hasPermission is stubbed open.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const mockPathname = vi.fn(() => '/dashboard')
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('./use-polled-count', () => ({ usePolledCount: vi.fn(() => 0) }))

import Sidebar from './Sidebar.jsx'
import { usePolledCount } from './use-polled-count'

// owner (not master) — real enough to pass the masterOrOwnerOnly gate on
// /portfolio without also rendering the master-only Platform link / the
// ImpersonatePicker, which would just be extra unrelated DOM. No
// `activeLocation` — Sidebar's branding effect no-ops without an id, so
// no fetch mock is needed either.
const USER = { role: 'owner', full_name: 'Test Owner' }

afterEach(() => {
  cleanup()
  usePolledCount.mockReturnValue(0)
})

describe('Sidebar — HOME.3 badge retirement', () => {
  it('renders no per-item badge pill, even when the poller reports a positive count', () => {
    // Mocked to a positive number on purpose — before HOME.3 this fed the
    // '/dashboard' badge (churnRadarCount + leadRadarCount) via the badges
    // map, and would have rendered a red pill. The badges map (and the 8
    // pollers that fed it) are gone; the one usePolledCount call left in
    // Sidebar.jsx drives only the tab-title prefix, never a per-row pill.
    usePolledCount.mockReturnValue(7)
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={USER} />)
    expect(screen.queryAllByLabelText(/pending$/)).toHaveLength(0)
    expect(document.querySelector('.bg-red-500')).toBeNull()
  })
})

describe('Sidebar — active state', () => {
  it('lights exactly one aria-current, on the Operations entry, for a former group-child page', () => {
    mockPathname.mockReturnValue('/presentations/xyz')
    render(<Sidebar user={USER} />)

    const current = screen.getAllByRole('link').filter(l => l.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Operations')
    expect(current[0].className).toContain('bg-un1t-border/50')
  })

  it('lights exactly one aria-current, on the Sales entry, for a route reached via extraActivePaths', () => {
    mockPathname.mockReturnValue('/contacts/abc')
    render(<Sidebar user={USER} />)

    const current = screen.getAllByRole('link').filter(l => l.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Sales')
  })
})
