// @vitest-environment jsdom
//
// UN1TSYNC.7 — the un1t.online tab: owner/master only, offered where it is or
// can become the membership source (un1t_online, or 'none' where connecting
// selects it) and never on a Glofox studio; its dot follows the membership-
// source STATE the way the Glofox tab's does.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=xero'),
  usePathname: () => '/settings/locations/loc-1',
}))

import LocationIntegrations from './LocationIntegrations.jsx'

const ID = 'a0000000-0000-4000-8000-000000000001'
const loc = (membership_source) => ({ id: ID, name: 'Hatch', features: {}, settings: {}, membership_source })
const MASTER = { role: 'master' }
const MANAGER = { role: 'manager', profileRole: 'manager', rolesByLocation: { [ID]: 'manager' }, locations: [{ id: ID }] }
const OWNER = { role: 'owner', profileRole: 'owner', rolesByLocation: { [ID]: 'owner' }, locations: [{ id: ID }] }

afterEach(() => cleanup())

const tab = () => screen.queryByRole('button', { name: /un1t\.online/ })

describe('LocationIntegrations — un1t.online tab', () => {
  it('is offered to a master on a studio with no membership source (connecting selects it)', () => {
    render(<LocationIntegrations location={loc('none')} user={MASTER} />)
    expect(tab()).toBeTruthy()
  })

  it('is offered to an owner of a studio on un1t_online', () => {
    render(<LocationIntegrations location={loc('un1t_online')} user={OWNER} membershipSource={{ source: 'un1t_online', state: 'configured' }} />)
    expect(tab()).toBeTruthy()
  })

  it('is not offered to a manager', () => {
    render(<LocationIntegrations location={loc('un1t_online')} user={MANAGER} />)
    expect(tab()).toBeNull()
  })

  it('is not offered on a Glofox studio', () => {
    render(<LocationIntegrations location={loc('glofox')} user={MASTER} />)
    expect(tab()).toBeNull()
  })

  it('shows a green dot only when un1t_online is the source and is configured', () => {
    const { rerender } = render(
      <LocationIntegrations location={loc('un1t_online')} user={MASTER} membershipSource={{ source: 'un1t_online', state: 'configured' }} />,
    )
    expect(tab().querySelector('svg.text-green-500')).toBeTruthy()
    rerender(<LocationIntegrations location={loc('none')} user={MASTER} membershipSource={{ source: 'none', state: 'none' }} />)
    expect(tab().querySelector('svg.text-green-500')).toBeNull()
    rerender(<LocationIntegrations location={loc('un1t_online')} user={MASTER} membershipSource={{ source: 'un1t_online', state: 'unknown' }} />)
    expect(screen.getByRole('img', { name: 'Could not load' })).toBeTruthy()
  })
})
