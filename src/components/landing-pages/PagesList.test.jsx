// @vitest-environment jsdom
//
// PAGES.1 — the Pages list at /settings/landing-page: one row per page with
// its path, studios, offer, status chip and the right editor link (a studio
// page still opens the legacy studio editor until PR3).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import PagesList from './PagesList'

afterEach(() => cleanup())

const HATCH = '11111111-1111-1111-1111-111111111111'
const STILL = '22222222-2222-2222-2222-222222222222'

function page(overrides) {
  return {
    id: 'p-1', organization_id: 'org-1', slug: 'trial', title: 'Trial', kind: 'campaign', scope: 'one',
    primary_location_id: HATCH, offer_type: 'paid_trial', publish_state: 'live', redirect_to: null,
    updated_at: '2026-10-28T10:00:00Z',
    studios: [{ location_id: HATCH, name: 'UN1T Hatch Street', enabled: true, ready: true, reason: 'ready' }],
    offer_summary: 'Paid trial: The 14 Day Reset', can_edit: true,
    ...overrides,
  }
}

const PAGES = [
  page({}),
  page({
    id: 'p-2', slug: 'corp', title: 'Corporate', scope: 'all', primary_location_id: null, offer_type: 'one_class',
    publish_state: 'coming_soon', offer_summary: 'One free class, per studio',
    studios: [
      { location_id: HATCH, name: 'UN1T Hatch Street', enabled: true, ready: true, reason: 'ready' },
      { location_id: STILL, name: 'UN1T Stillorgan', enabled: false, ready: false, reason: 'needs_plan' },
    ],
  }),
  page({
    id: 'p-3', slug: 'stillorgan', title: 'Stillorgan', kind: 'studio', primary_location_id: STILL,
    offer_type: 'none', publish_state: 'draft', offer_summary: 'No offer',
    studios: [{ location_id: STILL, name: 'UN1T Stillorgan', enabled: true, ready: true, reason: 'ready' }],
  }),
  page({ id: 'p-4', slug: 'old', title: 'Old promo', publish_state: 'retired', offer_summary: 'No offer', can_edit: false }),
]

const rowFor = (title) => screen.getByText(title).closest('tr')

describe('PagesList', () => {
  it('renders a row per page with the right chips and Edit links', () => {
    render(<PagesList pages={PAGES} canCreate studios={[]} />)

    const live = rowFor('Trial')
    expect(within(live).getByText('/trial')).toBeTruthy()
    expect(within(live).getByText('UN1T Hatch Street')).toBeTruthy()
    expect(within(live).getByText('Paid trial: The 14 Day Reset')).toBeTruthy()
    expect(within(live).getByText('Live').className).toContain('bg-green-500/10 text-green-700')
    expect(within(live).getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/settings/landing-page/p-1')

    const all = rowFor('Corporate')
    expect(within(all).getByText('All studios · 1 of 2 on')).toBeTruthy()
    expect(within(all).getByText('Coming soon').className).toContain('bg-amber-500/10 text-amber-700')

    const studio = rowFor('Stillorgan')
    expect(within(studio).getByText('Draft').className).toContain('bg-gray-500/10 text-gray-700')
    expect(within(studio).getByRole('link', { name: 'Edit' }).getAttribute('href'))
      .toBe(`/settings/landing-page?location_id=${STILL}`)

    const retired = rowFor('Old promo')
    expect(within(retired).getByText('Retired').className).toContain('bg-gray-500/10 text-gray-700')
    expect(within(retired).queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(within(retired).getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/settings/landing-page/p-4')
  })

  it('hides + New page without canCreate', () => {
    render(<PagesList pages={PAGES} canCreate={false} studios={[]} />)
    expect(screen.queryByRole('button', { name: /New page/ })).toBeNull()
  })

  it('opens the New page dialog from + New page', () => {
    render(<PagesList pages={PAGES} canCreate studios={[{ id: HATCH, name: 'UN1T Hatch Street' }]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /New page/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('shows the empty state, with New page only when the caller can create', () => {
    render(<PagesList pages={[]} canCreate studios={[]} canCreateAll />)
    expect(screen.getByText('No pages yet.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /New page/ }).length).toBeGreaterThan(0)
    cleanup()
    render(<PagesList pages={[]} canCreate={false} studios={[]} />)
    expect(screen.getByText('No pages yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /New page/ })).toBeNull()
  })

  it('links the front page editor for an organisation admin only', () => {
    render(<PagesList pages={PAGES} canCreate studios={[]} showFrontPage />)
    expect(screen.getByRole('link', { name: 'Front page' }).getAttribute('href')).toBe('/settings/landing-page?page=chooser')
    cleanup()
    render(<PagesList pages={PAGES} canCreate studios={[]} />)
    expect(screen.queryByRole('link', { name: 'Front page' })).toBeNull()
  })
})
