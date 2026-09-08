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
import { hasPermission } from '@/lib/permissions'

// owner (not master) — real enough to pass the masterOrOwnerOnly gate on
// /portfolio without also rendering the master-only Platform link / the
// ImpersonatePicker, which would just be extra unrelated DOM. No
// `activeLocation` — Sidebar's branding effect no-ops without an id, so
// no fetch mock is needed either.
const USER = { role: 'owner', full_name: 'Test Owner' }

afterEach(() => {
  cleanup()
  usePolledCount.mockReturnValue(0)
  usePolledCount.mockClear()
  hasPermission.mockImplementation(() => true)
})

describe('Sidebar — HOME.3 badge retirement, as amended', () => {
  // HOME.3 retired all eight per-item pills; MAIL-BADGE.1 restored Messages
  // and NAV-BADGE.1 restored Approvals. Everything else stays retired — in
  // particular the old RED pill and its "N pending" label are gone for good.
  it('badges only Messages and Approvals, even when every poller reports a count', () => {
    usePolledCount.mockReturnValue(7)
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={USER} />)
    const rows = screen.getAllByTestId('nav-badge').map(b => b.closest('a')?.textContent)
    expect(rows).toHaveLength(2)
    expect(rows.join(' ')).toContain('Approvals')
    expect(rows.join(' ')).toContain('Messages')
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

// FU-PLATFORM-LINK — the master-only "Platform" link used to point ONLY
// at the external https://platform.un1tdublin.com (the old, separately-
// deployed un1t-platform app — see docs/INFRA_BACKLOG.md #5, tagged for
// retirement). The in-app Platform console (8 pages, src/lib/platform-
// nav.js) has since shipped at /admin/tenants with no sidebar entry of
// its own, so masters had no persistent link to their own console. Fix:
// repoint the primary link internally, keep the old one as a smaller
// secondary "Legacy platform" link so nothing already relying on it
// (whatever docs/INFRA_BACKLOG.md #5's "confirm/port the surfaces" step
// hasn't resolved yet) gets stranded.
describe('Sidebar — Platform links (FU-PLATFORM-LINK)', () => {
  const MASTER = { role: 'master', full_name: 'Test Master' }

  it('shows an internal "Platform console" link to /admin/tenants for a master', () => {
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={MASTER} />)
    const link = screen.getByRole('link', { name: /Platform console/ })
    expect(link.getAttribute('href')).toBe('/admin/tenants')
    // Internal Link, not an external tab-opener.
    expect(link.getAttribute('target')).toBeNull()
  })

  it('keeps a secondary external "Legacy platform" link to the old un1t-platform app', () => {
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={MASTER} />)
    const link = screen.getByRole('link', { name: /Legacy platform/ })
    expect(link.getAttribute('href')).toBe('https://platform.un1tdublin.com')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('renders neither Platform link for a non-master (owner)', () => {
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={USER} />)
    expect(screen.queryByRole('link', { name: /Platform console/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Legacy platform/ })).toBeNull()
  })
})


// ── MAIL-BADGE.1 / NAV-BADGE.1 — the per-row outstanding-items badges ───
// Two rows can badge at once now, so every assertion here scopes to a row
// rather than reaching for "the" pill.
const badgeOnRow = (label) =>
  screen.getAllByTestId('nav-badge').find(b => b.closest('a')?.textContent?.includes(label))

describe('Messages badge', () => {
  it('sums the two hub counts onto the Messages row, estate mail included', () => {
    usePolledCount.mockImplementation(({ url }) => {
      if (url === '/api/whatsapp/unread-count') return 3
      if (url === '/api/email/mail/count?scope=all') return 14
      return 0
    })
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Messages').textContent).toBe('17')
  })

  it('renders NO badge at zero — an empty pill is noise', () => {
    usePolledCount.mockReturnValue(0)
    render(<Sidebar user={USER} />)
    expect(screen.queryByTestId('nav-badge')).toBeNull()
  })

  it('polls mail with scope=all — the estate, not the active studio', () => {
    render(<Sidebar user={USER} />)
    const urls = usePolledCount.mock.calls.map(([a]) => a?.url)
    expect(urls).toContain('/api/email/mail/count?scope=all')
  })

  it('caps the render at 99+', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/email/mail/count?scope=all' ? 250 : 0)
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Messages').textContent).toBe('99+')
  })
})

// ── NAV-BADGE.1 — the Approvals row ────────────────────────────────────
describe('Approvals badge', () => {
  it('badges the Approvals row from its own endpoint, not the Messages one', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 7 : 0)
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Approvals').textContent).toBe('7')
    expect(badgeOnRow('Messages')).toBeUndefined()
  })

  // The endpoint self-gates, so there is nothing to gate on here. A
  // client-side hasPermission would also be checking the WRONG key: the nav
  // row's key is approvals_inbox, while of the eleven registered providers
  // eight gate on their own distinct approvals_* key and the remaining
  // three (invoices_queue, issues, host_events) gate on bookkeeper /
  // issues_inbox / reviewer roles instead — none of the eleven is actually
  // approvals_inbox, so a client-side check here could hide a badge for
  // real work either way.
  it('polls unconditionally for a signed-in user', () => {
    render(<Sidebar user={USER} />)
    const call = usePolledCount.mock.calls.map(([a]) => a).find(a => a?.url === '/api/approvals/count')
    expect(call).toBeTruthy()
    expect(call.enabled).toBe(true)
  })

  it('no longer polls /api/home-queue/count — the title sums the visible pills now', () => {
    render(<Sidebar user={USER} />)
    const urls = usePolledCount.mock.calls.map(([a]) => a?.url)
    expect(urls).not.toContain('/api/home-queue/count')
  })

  it('titles the tab with the SUM of both badges, so title and pills agree', () => {
    usePolledCount.mockImplementation(({ url }) => {
      if (url === '/api/approvals/count') return 7
      if (url === '/api/whatsapp/unread-count') return 3
      return 0
    })
    render(<Sidebar user={USER} />)
    expect(document.title).toMatch(/^\(10\) /)
  })

  // The endpoint's gate and the nav row's gate are NOT the same question, so a
  // caller can have a real count with no visible row (a bookkeeper without
  // approvals_inbox). The title must follow the PILLS, not the pollers.
  it('excludes a row the user cannot see from the title', () => {
    hasPermission.mockImplementation((_u, key) => key !== 'approvals_inbox')
    usePolledCount.mockImplementation(({ url }) => {
      if (url === '/api/approvals/count') return 7
      if (url === '/api/whatsapp/unread-count') return 3
      return 0
    })
    render(<Sidebar user={USER} />)
    expect(screen.queryByRole('link', { name: /Approvals/ })).toBeNull()
    expect(document.title).toMatch(/^\(3\) /)
  })

  it('labels the pill for screen readers — a bare number announces as nothing', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 7 : 0)
    render(<Sidebar user={USER} />)
    expect(screen.getByLabelText('7 items need your attention')).toBeTruthy()
  })

  it('says "item", singular, at one', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 1 : 0)
    render(<Sidebar user={USER} />)
    expect(screen.getByLabelText('1 item needs your attention')).toBeTruthy()
  })
})
