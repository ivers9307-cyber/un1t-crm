// @vitest-environment jsdom
// CHANNELREAD.1 — the Xero tab never offers Connect Xero over a read that failed.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const DRAWER_QS = 'manage=xero&location=a0000000-0000-4000-8000-000000000001'
const nav = vi.hoisted(() => ({ search: 'manage=xero&location=a0000000-0000-4000-8000-000000000001', replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/settings/integrations-hub',
}))

import XeroIntegrationTab from './XeroIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }
afterEach(() => { cleanup(); nav.search = DRAWER_QS })

describe('XeroIntegrationTab', () => {
  it('readFailed with no onRetry → Could not load + a Try again link to this hub drawer; no Connect, no "Not connected"', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} readFailed />)
    expect(screen.getByText(/Could not load this location's Xero connection just now/)).toBeTruthy()
    // INTEGONE.1 — the per-location tab is retired; the drawer's URL re-opens it.
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(`/settings/integrations-hub?manage=xero&location=${LOC.id}`)
    expect(screen.queryByText(/Connect Xero/)).toBeNull()
    expect(screen.queryByText('Not connected.')).toBeNull()
  })

  it('readFailed with onRetry (how the hub drawer hosts it) → a Try again button that calls it; still no Connect', async () => {
    const onRetry = vi.fn(async () => {})
    render(<XeroIntegrationTab location={LOC} connection={null} readFailed onRetry={onRetry} />)
    expect(screen.queryByRole('link', { name: 'Try again' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Connect Xero/)).toBeNull()
  })

  it('pin: a real "no connection" still offers Connect Xero', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByText(/Connect Xero/)).toBeTruthy()
  })

  // CHANNELREAD.1 — the callback's outcome used to ride in the URL unread.
  // The hub drawer passes showCallbackNotice=false (the hub page shows it);
  // the default still renders it.
  it('shows the callback outcome and cleans it from the URL', () => {
    nav.search = `${DRAWER_QS}&xero_error=all_taken`
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByRole('alert').textContent).toContain('is already connected to another location')
    expect(nav.replace).toHaveBeenCalledWith(`/settings/integrations-hub?${DRAWER_QS}`, { scroll: false })
  })

  it('shows the callback confirmation above the card', () => {
    nav.search = `${DRAWER_QS}&xero_connected=1`
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByRole('status').textContent).toContain('Xero connected.')
  })
})
