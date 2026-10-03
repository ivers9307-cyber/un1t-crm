// @vitest-environment jsdom
// CHANNELREAD.1 — the Xero OAuth callback's outcome is shown, then cleaned
// from the URL so a reload does not show it again.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const nav = vi.hoisted(() => ({ search: '', pathname: '/settings/locations/loc-1', replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}))

import XeroCallbackNotice from './XeroCallbackNotice.jsx'

beforeEach(() => {
  nav.replace.mockReset()
  nav.pathname = '/settings/locations/loc-1'
})
afterEach(() => cleanup())

describe('XeroCallbackNotice', () => {
  it('renders nothing and leaves the URL alone with no callback params', () => {
    nav.search = 'tab=xero'
    const { container } = render(<XeroCallbackNotice />)
    expect(container.textContent).toBe('')
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it('success → a short confirmation, then the params are cleaned (tab kept)', () => {
    nav.search = 'tab=xero&xero_connected=1'
    render(<XeroCallbackNotice />)
    expect(screen.getByRole('status').textContent).toContain('Xero connected.')
    expect(nav.replace).toHaveBeenCalledWith('/settings/locations/loc-1?tab=xero', { scroll: false })
  })

  it('success on a several-org login → the check-this-org warning', () => {
    nav.search = 'tab=xero&xero_connected=1&xero_orgs=2'
    render(<XeroCallbackNotice />)
    expect(screen.getByRole('status').textContent).toContain('This login gives access to 2 organisations and one was picked for this location, so check it is the right one.')
  })

  it.each([
    ['not_permitted', 'Only an owner of this location can connect Xero, so nothing was changed.'],
    ['declined', 'Xero did not grant access, so nothing was changed.'],
    ['missing_code', 'Xero did not send back what was needed to finish connecting'],
    ['state_mismatch', 'The Xero sign-in could not be matched to this browser'],
    ['invalid_state', 'The Xero sign-in could not be matched to this browser'],
    ['no_tenants', 'This Xero login does not give access to any organisation'],
    ['taken_read_failed', 'Could not check which Xero organisations are already connected'],
    ['all_taken', 'is already connected to another location'],
    ['save_failed', 'The Xero connection could not be saved'],
    ['xero_error', 'something went wrong talking to Xero'],
  ])('error %s → its plain copy as an alert', (code, text) => {
    nav.search = `tab=xero&xero_error=${code}`
    render(<XeroCallbackNotice />)
    expect(screen.getByRole('alert').textContent).toContain(text)
    expect(nav.replace).toHaveBeenCalledWith('/settings/locations/loc-1?tab=xero', { scroll: false })
  })

  it('an unknown code → "Xero did not connect", and the raw value is never rendered (as text or HTML)', () => {
    nav.search = `xero_error=${encodeURIComponent('<b id="pwn">evil</b>')}`
    nav.pathname = '/settings'
    const { container } = render(<XeroCallbackNotice />)
    expect(screen.getByRole('alert').textContent).toContain('Xero did not connect, so nothing was changed. Try connecting again.')
    expect(container.querySelector('#pwn')).toBeNull()
    expect(container.textContent).not.toContain('evil')
    expect(nav.replace).toHaveBeenCalledWith('/settings', { scroll: false })
  })

  it('the old free-text ?error= param is not ours and is ignored', () => {
    nav.search = 'error=Something+else'
    const { container } = render(<XeroCallbackNotice />)
    expect(container.textContent).toBe('')
  })

  it('Dismiss hides the notice', () => {
    nav.search = 'xero_error=declined'
    render(<XeroCallbackNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
