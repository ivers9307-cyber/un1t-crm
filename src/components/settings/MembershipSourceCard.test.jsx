// @vitest-environment jsdom
//
// W1.M2 — the per-location "Membership source" card (hosted in the
// Integrations hub's Manage drawer since INTEGONE.1; these cases used to run
// through the retired per-location Integrations tab, which rendered it above
// its tab strip).
//
//   - the select lists every value the mig 717 CHECK admits: none, glofox,
//     un1t, un1t_online — and un1t is DISABLED ("not available yet") until its
//     provider module registers (the route refuses it too; the UI is the courtesy)
//   - only an owner at this location or a master can save (the route's gate;
//     the drawer passes canEdit = the server's isOwnerOrMaster flag)
//   - Save PUTs /api/locations/[id]/membership-source and shows the route's
//     `glofox_credentials_kept` warning
//   - a failed state read says so instead of pretending "none"

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/settings/integrations-hub',
}))

import MembershipSourceCard from './MembershipSourceCard.jsx'

const LOC_ID = 'a0000000-0000-4000-8000-000000000001'

beforeEach(() => {
  refresh.mockReset()
  global.fetch = vi.fn()
})
afterEach(() => {
  cleanup()
  delete global.fetch
})

describe('MembershipSourceCard', () => {
  it('renders the four CHECK values with un1t disabled and labelled not available yet', () => {
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: 'none', state: 'none' }} canEdit />)
    const select = screen.getByRole('combobox', { name: /membership source/i })
    const options = Array.from(select.querySelectorAll('option'))
    expect(options.map((o) => o.value)).toEqual(['none', 'glofox', 'un1t', 'un1t_online'])
    expect(options.find((o) => o.value === 'un1t').disabled).toBe(true)
    // A neutral, tenant-safe label: the KEY is un1t (schema), the copy is not.
    expect(options.find((o) => o.value === 'un1t').textContent).toMatch(/built-in memberships/i)
    expect(options.find((o) => o.value === 'un1t').textContent).not.toMatch(/un1t/i)
    expect(options.find((o) => o.value === 'un1t').textContent).toMatch(/not available yet/i)
    expect(options.find((o) => o.value === 'glofox').disabled).toBe(false)
    expect(options.find((o) => o.value === 'none').disabled).toBe(false)
    expect(options.find((o) => o.value === 'un1t_online').disabled).toBe(false)
    expect(options.find((o) => o.value === 'un1t_online').textContent).toBe('un1t.online')
    expect(select.value).toBe('none')
  })

  it('canEdit (an owner here or a master) can save', () => {
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: 'none', state: 'none' }} canEdit />)
    expect(screen.getByRole('combobox', { name: /membership source/i }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /save membership source/i })).toBeTruthy()
  })

  it('without canEdit the value is read-only, with no Save (the route refuses a manager too)', () => {
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: 'none', state: 'none' }} canEdit={false} />)
    expect(screen.getByRole('combobox', { name: /membership source/i }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /save membership source/i })).toBeNull()
  })

  it('Save PUTs the chosen source, refreshes the page, and surfaces the credentials-kept warning', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, warning: 'glofox_credentials_kept', data: { source: 'none', state: 'none', previous: 'glofox' } }),
    })
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: 'glofox', state: 'configured' }} canEdit />)
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
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: 'none', state: 'none' }} canEdit />)
    fireEvent.change(screen.getByRole('combobox', { name: /membership source/i }), { target: { value: 'glofox' } })
    fireEvent.click(screen.getByRole('button', { name: /save membership source/i }))
    await screen.findByText(/not available yet/i)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('an unknown state (the read failed) says so instead of pretending "none"', () => {
    render(<MembershipSourceCard locationId={LOC_ID} membershipSource={{ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' }} canEdit />)
    expect(screen.getByText(/could not load the membership source/i)).toBeTruthy()
  })
})
