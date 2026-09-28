// @vitest-environment jsdom
// CHANNELREAD.1 — the Xero tab never offers Connect Xero over a read that failed.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const nav = vi.hoisted(() => ({ search: 'tab=xero', replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/settings/locations/a0000000-0000-4000-8000-000000000001',
}))

import XeroIntegrationTab from './XeroIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }
afterEach(() => { cleanup(); nav.search = 'tab=xero' })

describe('XeroIntegrationTab', () => {
  it('readFailed → Could not load + a Try again link back to the tab; no Connect, no "Not connected"', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} readFailed />)
    expect(screen.getByText(/Could not load this location's Xero connection just now/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(`/settings/locations/${LOC.id}?tab=xero`)
    expect(screen.queryByText(/Connect Xero/)).toBeNull()
    expect(screen.queryByText('Not connected.')).toBeNull()
  })

  it('pin: a real "no connection" still offers Connect Xero', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByText(/Connect Xero/)).toBeTruthy()
  })

  // CHANNELREAD.1 — the OAuth callback lands here by default; its outcome
  // used to ride in the URL unread.
  it('shows the callback outcome and cleans it from the URL', () => {
    nav.search = 'tab=xero&xero_error=all_taken'
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByRole('alert').textContent).toContain('is already connected to another location')
    expect(nav.replace).toHaveBeenCalledWith(`/settings/locations/${LOC.id}?tab=xero`, { scroll: false })
  })

  it('shows the callback confirmation above the card', () => {
    nav.search = 'tab=xero&xero_connected=1'
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByRole('status').textContent).toContain('Xero connected.')
  })
})
