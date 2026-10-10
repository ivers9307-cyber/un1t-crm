// @vitest-environment jsdom
//
// W1.M2 — the "Membership source" card above the integrations tab strip, and
// the Glofox tab's status dot reading membershipSourceState (replacing the
// old `settings?.glofox?.api_key` sniff, SaaS review theme E test (e)).
//
//   - the select lists every value the mig 717 CHECK admits: none, glofox,
//     un1t — and un1t is DISABLED ("not available yet") until its provider
//     module registers (the route refuses it too; the UI is the courtesy)
//   - only an owner at this location or a master can save (the route's gate)
//   - Save PUTs /api/locations/[id]/membership-source and shows the route's
//     `glofox_credentials_kept` warning
//   - the Glofox tab's dot is the STATE: configured → green, unconfigured →
//     grey, unknown → amber "Could not load"; and the tab shows whenever the
//     source is glofox, even with no legacy settings slice

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh }),
  useSearchParams: () => new URLSearchParams('tab=glofox'),
  usePathname: () => '/settings/locations/loc-1',
}))

import LocationIntegrations from './LocationIntegrations.jsx'

const LOC_ID = 'a0000000-0000-4000-8000-000000000001'
const LOC = { id: LOC_ID, name: 'Synthetic Studio', features: {}, settings: {}, membership_source: 'none' }
const MASTER = { role: 'master', profileRole: 'master', rolesByLocation: {} }
const OWNER_HERE = { role: 'owner', profileRole: 'owner', rolesByLocation: { [LOC_ID]: 'owner' } }
const MANAGER_HERE = { role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC_ID]: 'manager' } }

beforeEach(() => {
  refresh.mockReset()
  global.fetch = vi.fn()
})
afterEach(() => {
  cleanup()
  delete global.fetch
})

describe('LocationIntegrations — Membership source card', () => {
  it('renders the three CHECK values with un1t disabled and labelled not available yet', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MASTER} membershipSource={{ source: 'none', state: 'none' }} />)
    const select = screen.getByRole('combobox', { name: /membership source/i })
    const options = Array.from(select.querySelectorAll('option'))
    expect(options.map((o) => o.value)).toEqual(['none', 'glofox', 'un1t'])
    expect(options.find((o) => o.value === 'un1t').disabled).toBe(true)
    // A neutral, tenant-safe label: the KEY is un1t (schema), the copy is not.
    expect(options.find((o) => o.value === 'un1t').textContent).toMatch(/built-in memberships/i)
    expect(options.find((o) => o.value === 'un1t').textContent).not.toMatch(/un1t/i)
    expect(options.find((o) => o.value === 'un1t').textContent).toMatch(/not available yet/i)
    expect(options.find((o) => o.value === 'glofox').disabled).toBe(false)
    expect(options.find((o) => o.value === 'none').disabled).toBe(false)
    expect(select.value).toBe('none')
  })

  it('an owner at this location can save', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={OWNER_HERE} membershipSource={{ source: 'none', state: 'none' }} />)
    expect(screen.getByRole('combobox', { name: /membership source/i }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /save membership source/i })).toBeTruthy()
  })

  it('a manager sees the value read-only (the route refuses them too)', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MANAGER_HERE} membershipSource={{ source: 'none', state: 'none' }} />)
    expect(screen.getByRole('combobox', { name: /membership source/i }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /save membership source/i })).toBeNull()
  })

  it('Save PUTs the chosen source, refreshes the page, and surfaces the credentials-kept warning', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, warning: 'glofox_credentials_kept', data: { source: 'none', state: 'none', previous: 'glofox' } }),
    })
    render(
      <LocationIntegrations
        location={{ ...LOC, membership_source: 'glofox' }}
        xeroConnection={null}
        user={MASTER}
        membershipSource={{ source: 'glofox', state: 'configured' }}
      />,
    )
    const select = screen.getByRole('combobox', { name: /membership source/i })
    fireEvent.change(select, { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: /save membership source/i }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`/api/locations/${LOC_ID}/membership-source`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ membership_source: 'none' })
    await screen.findByText(/credentials were kept/i)
    expect(refresh).toHaveBeenCalled()
  })

  it('a refused save shows the route error and keeps the editor', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, code: 'not_available_yet', error: "'un1t' is not available yet." }),
    })
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MASTER} membershipSource={{ source: 'none', state: 'none' }} />)
    fireEvent.change(screen.getByRole('combobox', { name: /membership source/i }), { target: { value: 'glofox' } })
    fireEvent.click(screen.getByRole('button', { name: /save membership source/i }))
    await screen.findByText(/not available yet/i)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('an unknown state (the read failed) says so instead of pretending "none"', () => {
    render(<LocationIntegrations location={LOC} xeroConnection={null} user={MASTER} membershipSource={{ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' }} />)
    expect(screen.getByText(/could not load the membership source/i)).toBeTruthy()
  })
})

describe('LocationIntegrations — the Glofox tab reads the membership-source STATE', () => {
  function glofoxTab() {
    return screen.getByRole('button', { name: /^Glofox/ })
  }

  it('configured → green dot; the tab shows for a glofox source even with no legacy settings slice', () => {
    render(
      <LocationIntegrations
        location={{ ...LOC, membership_source: 'glofox', settings: {} }}
        xeroConnection={null}
        user={MASTER}
        membershipSource={{ source: 'glofox', state: 'configured' }}
      />,
    )
    const tab = glofoxTab()
    expect(tab.querySelector('.text-green-500')).toBeTruthy()
  })

  it('unconfigured → grey dot, never green, even when a legacy api_key sits in settings', () => {
    render(
      <LocationIntegrations
        location={{ ...LOC, membership_source: 'glofox', settings: { glofox: { api_key: 'masked' } } }}
        xeroConnection={null}
        user={MASTER}
        membershipSource={{ source: 'glofox', state: 'unconfigured', missing: ['Branch ID'] }}
      />,
    )
    const tab = glofoxTab()
    expect(tab.querySelector('.text-green-500')).toBeNull()
    expect(tab.querySelector('.bg-un1t-muted')).toBeTruthy()
  })

  it('unknown → the amber "Could not load" image', () => {
    render(
      <LocationIntegrations
        location={{ ...LOC, membership_source: 'glofox' }}
        xeroConnection={null}
        user={MASTER}
        membershipSource={{ source: 'glofox', state: 'unknown', readError: 'GLOFOX_SETTINGS_UNREADABLE' }}
      />,
    )
    expect(screen.getByRole('button', { name: /Glofox.*Could not load/ })).toBeTruthy()
  })

  it('a location on "none" with a bookings feature still shows the Glofox tab as not configured (legacy visibility rule kept)', () => {
    render(
      <LocationIntegrations
        location={{ ...LOC, features: { bookings: true } }}
        xeroConnection={null}
        user={MASTER}
        membershipSource={{ source: 'none', state: 'none' }}
      />,
    )
    const tab = glofoxTab()
    expect(tab.querySelector('.text-green-500')).toBeNull()
  })
})
