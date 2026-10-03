// @vitest-environment jsdom
//
// CHANNELREAD.1 — the hub's inline Xero Connect passes
// return_to=/settings/integrations-hub, so the OAuth callback lands HERE with
// its outcome code in the URL. The hub shows it, then cleans the URL.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))
vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
vi.mock('./IntegrationsHubDrawer', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/settings/integrations-hub',
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}))

import IntegrationsHub from './IntegrationsHub'

const LOC = { id: 'loc-a', name: 'Synthetic Studio' }
const EMPTY = {
  generatedAt: '2026-09-28T09:00:00Z', expirySoonDays: 10, locations: [LOC],
  glofox: [], whatsapp: [], instagram: [], xero: [], ads: [], shelly: [], sms: [], agent: [],
  email: [], unifi: [], climate: [], bca: [], billing: [], attention: [],
}

afterEach(() => { cleanup(); nav.replace.mockReset(); nav.search = '' })

describe('IntegrationsHub — Xero callback outcome', () => {
  it('shows an error code as plain copy and cleans the URL', () => {
    nav.search = 'xero_error=taken_read_failed'
    render(<IntegrationsHub data={EMPTY} isMaster />)
    expect(screen.getByRole('alert').textContent).toContain('Could not check which Xero organisations are already connected, so nothing was changed.')
    expect(nav.replace).toHaveBeenCalledWith('/settings/integrations-hub', { scroll: false })
  })

  it('shows the confirmation on success', () => {
    nav.search = 'xero_connected=1'
    render(<IntegrationsHub data={EMPTY} isMaster />)
    expect(screen.getByRole('status').textContent).toContain('Xero connected.')
  })

  it('shows nothing without callback params', () => {
    render(<IntegrationsHub data={EMPTY} isMaster />)
    expect(screen.queryByText(/Xero connected|Xero did not/)).toBeNull()
    expect(nav.replace).not.toHaveBeenCalled()
  })
})
