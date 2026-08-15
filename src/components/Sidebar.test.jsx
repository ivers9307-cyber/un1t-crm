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

// owner (not master) — real enough to pass the masterOrOwnerOnly gate on
// /portfolio without also rendering the master-only Platform link / the
// ImpersonatePicker, which would just be extra unrelated DOM. No
// `activeLocation` — Sidebar's branding effect no-ops without an id, so
// no fetch mock is needed either.
const USER = { role: 'owner', full_name: 'Test Owner' }

afterEach(cleanup)

describe('Sidebar — active state', () => {
  it('lights exactly one aria-current, on the Presentations child row, when a group child page is current', () => {
    mockPathname.mockReturnValue('/presentations/xyz')
    render(<Sidebar user={USER} />)

    const current = screen.getAllByRole('link').filter(l => l.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Presentations')

    // The Studio Management parent still visually tints (section
    // context), but does NOT also claim aria-current.
    const parent = screen.getByRole('link', { name: /Studio Management/ })
    expect(parent.getAttribute('aria-current')).toBeNull()
    expect(parent.className).toContain('bg-un1t-border/50')
  })

  it('lights exactly one aria-current, on the Sales entry, for a route reached via extraActivePaths', () => {
    mockPathname.mockReturnValue('/contacts/abc')
    render(<Sidebar user={USER} />)

    const current = screen.getAllByRole('link').filter(l => l.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Sales')
  })
})
