// @vitest-environment jsdom
//
// WAROLE.1 — the WhatsApp tab (numbers, Connect, chat openers, card sets) is
// judged the way every write on it is judged: guardMasterOrOwner AT this
// location. It used to read `user.role`, the caller's role at their ACTIVE
// studio, so an owner here whose active studio is one where they manage saw
// no tab on a page that is theirs (and the reverse caller, owner at the active
// studio but staff here, would have seen editors whose saves now 403; the page
// redirects that caller, this pins the tab regardless). Ids are synthetic.

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
const MASTER = { role: 'master', profileRole: 'master', rolesByLocation: {}, activeLocation: { id: HERE } }

const whatsappTab = () => screen.queryByRole('button', { name: /WhatsApp/ })

afterEach(() => cleanup())

describe('LocationIntegrations — the WhatsApp tab is judged at this location (WAROLE.1)', () => {
  it('owner here, manager at the active studio: shown (was hidden)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'owner', [OTHER]: 'manager' }, OTHER)} />)
    expect(whatsappTab()).not.toBeNull()
  })

  it('owner at the active studio, staff here: hidden (was shown)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'staff', [OTHER]: 'owner' }, OTHER)} />)
    expect(whatsappTab()).toBeNull()
  })

  it('a manager here: hidden (the saves behind it are master/owner)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'manager' }, HERE)} />)
    expect(whatsappTab()).toBeNull()
  })

  it('owner here, active here: shown (unchanged)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={caller({ [HERE]: 'owner' }, HERE)} />)
    expect(whatsappTab()).not.toBeNull()
  })

  it('a master: shown (unchanged)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MASTER} />)
    expect(whatsappTab()).not.toBeNull()
  })

  it('the feature switched off hides it from an owner, a master still sees it (unchanged)', () => {
    const off = { ...LOC, features: { whatsapp: false } }
    render(<LocationIntegrations location={off} xeroConnection={null} user={caller({ [HERE]: 'owner' }, HERE)} />)
    expect(whatsappTab()).toBeNull()
    cleanup()
    render(<LocationIntegrations location={off} xeroConnection={null} user={MASTER} />)
    expect(whatsappTab()).not.toBeNull()
  })
})
