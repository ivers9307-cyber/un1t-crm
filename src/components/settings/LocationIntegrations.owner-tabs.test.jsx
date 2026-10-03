// @vitest-environment jsdom
//
// PAGEGATES.1 — /settings/locations/[id] admits master or owner AT this
// location (guardMasterOrOwner), and the routes behind the Xero, Payments,
// Instagram, Ads, AC devices and BCA tabs judge at this location too. The
// tabs read `user.role`, the ACTIVE studio's role, so an owner here whose
// active studio is one where they manage reached the page and found those
// tabs missing (and Glofox read-only). Ids are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=xero'),
  usePathname: () => '/settings/locations/loc-1',
}))

import LocationIntegrations from './LocationIntegrations.jsx'

const HERE = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'
const LOC = { id: HERE, name: 'Synthetic Studio', features: {}, settings: {} }
const caller = (roles, active) => ({ role: roles[active], profileRole: 'staff', rolesByLocation: roles, activeLocation: { id: active } })

// The strip's tab button (the open Xero tab carries its own Xero buttons too).
const tab = (name) => screen.queryAllByRole('button', { name })[0] ?? null

afterEach(cleanup)

describe('LocationIntegrations — the owner tabs are judged at this location (PAGEGATES.1)', () => {
  it('owner here, manager at the active studio: Xero, Payments and Ads shown (were hidden)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'owner', [OTHER]: 'manager' }, OTHER)} />)
    expect(tab(/Xero/)).not.toBeNull()
    expect(tab(/Payments/)).not.toBeNull()
    expect(tab(/Ads/)).not.toBeNull()
  })

  it('owner at the active studio, staff here: hidden (the page redirects this caller; the tabs never rely on it)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'staff', [OTHER]: 'owner' }, OTHER)} />)
    expect(tab(/Xero/)).toBeNull()
    expect(tab(/Payments/)).toBeNull()
  })

  it('owner here, active here: shown (unchanged)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'owner' }, HERE)} />)
    expect(tab(/Xero/)).not.toBeNull()
  })
})
