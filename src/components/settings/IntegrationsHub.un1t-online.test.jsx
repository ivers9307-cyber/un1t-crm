// @vitest-environment jsdom
//
// UN1TSYNC.5 — the un1t.online hub card renders only where there is a
// connection to show, opens the location's un1t-online Manage drawer
// (INTEGONE.1: no deep link out to the old tab), and carries nothing but the
// non-secret fields the assembler gives it.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
vi.mock('./IntegrationsHubDrawer', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/settings/integrations-hub',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))

import IntegrationsHub from './IntegrationsHub'

const LOC = { id: 'loc-h', name: 'Hatch Street' }
const BASE = {
  generatedAt: '2026-10-16T09:00:00Z',
  expirySoonDays: 10,
  locations: [LOC],
  glofox: [], whatsapp: [], instagram: [], xero: [], ads: [], shelly: [], agent: [], email: [],
  unifi: [], climate: [], bca: [], billing: [], attention: [],
}
const row = (extra = {}) => ({
  locationId: LOC.id, status: 'connected', studioTitle: 'Hatch Street', tokenExpiresAt: '2027-03-01T00:00:00Z',
  lastOkAt: '2026-10-16T08:45:00Z', lastError: null, href: `/settings/integrations-hub?manage=un1t-online&location=${LOC.id}`, ...extra,
})

describe('IntegrationsHub — un1t.online card (UN1TSYNC.5)', () => {
  it('renders the studio title with a Manage button, never a link to the old tab', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={{ ...BASE, un1t_online: [row()] }} isMaster />)
    expect(html).toContain('un1t.online')
    expect(html).toContain('Hatch Street')
    expect(html).toContain('>Manage<')
    expect(html).not.toContain('/settings/locations/')
  })

  it('offers Connect on a studio that may connect but has not yet (UN1THUB.1), opening its drawer', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={{ ...BASE, un1t_online: [row({ status: 'not_connected', studioTitle: null, tokenExpiresAt: null, lastOkAt: null, offerConnect: true })] }} isMaster />)
    expect(html).toContain('Members, subscriptions, payments')
    expect(html).toContain('Not connected')
    expect(html).toContain('>Connect<')
    expect(html).not.toContain('/settings/locations/')
  })

  it('shows no card for a studio that never connected it, or when the payload predates the key', () => {
    for (const un1t_online of [[row({ status: 'not_connected', studioTitle: null, tokenExpiresAt: null, lastOkAt: null })], [row({ status: 'unknown' })], undefined]) {
      const html = renderToStaticMarkup(<IntegrationsHub data={{ ...BASE, un1t_online }} isMaster />)
      expect(html).not.toContain('Members, subscriptions, payments')
    }
  })
})
