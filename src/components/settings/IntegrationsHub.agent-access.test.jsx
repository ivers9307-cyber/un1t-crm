// @vitest-environment jsdom
//
// MCP.1 — the hub renders one Agent access card per organisation the viewer
// administers (managedOrgs) and none when the page supplied no `mcp`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/settings/integrations-hub',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
vi.mock('./IntegrationsHubDrawer', () => ({ default: () => null }))

import IntegrationsHub from './IntegrationsHub'

const A = { id: 'loc-a', name: 'Stillorgan' }
const DATA = {
  generatedAt: '2026-11-01T09:00:00Z', expirySoonDays: 10, locations: [A],
  glofox: [], whatsapp: [], instagram: [], xero: [], ads: [], shelly: [], agent: [], email: [],
  membershipSource: [], payments: [], climate: [], bca: [], billing: [], attention: [],
}
const MCP = { enabled: true, connectorUrl: 'https://crm.example.test/api/mcp', people30d: 4 }

afterEach(() => cleanup())

describe('IntegrationsHub — Agent access card', () => {
  it('renders a card for an organisation the page loaded mcp for', () => {
    render(<IntegrationsHub data={DATA} managedOrgs={[{ id: 'org-1', name: 'UN1T Group', locations: [A], mcp: MCP }]} />)
    expect(screen.getByText('Agent access')).toBeTruthy()
    expect(screen.getByText('https://crm.example.test/api/mcp')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('renders no card when the organisation carries no mcp, and none for a non-admin', () => {
    render(<IntegrationsHub data={DATA} managedOrgs={[{ id: 'org-1', name: 'UN1T Group', locations: [A] }]} />)
    expect(screen.queryByText('Agent access')).toBeNull()
    cleanup()
    render(<IntegrationsHub data={DATA} />)
    expect(screen.queryByText('Agent access')).toBeNull()
  })

  it('an unreadable state (mcp: null) renders the card with a note and no switch', () => {
    render(<IntegrationsHub data={DATA} managedOrgs={[{ id: 'org-1', name: 'UN1T Group', locations: [A], mcp: null }]} />)
    expect(screen.getByText('Agent access')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
