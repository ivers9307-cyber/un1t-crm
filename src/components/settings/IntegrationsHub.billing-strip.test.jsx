// @vitest-environment jsdom
//
// C141 ORGROLE.2 — the plan & wallet strip is organisation-level billing data
// (organisation admins only). The route/page build `billing` rows only for the
// locations of an organisation the caller administers, so a studio owner's
// payload carries none. The hub must then show NO strip at all: an empty
// strip would read "No platform plan", a fact about billing this viewer may
// not see (and one that may be false).

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

const LOC = { id: 'loc-a', name: 'Stillorgan' }
const BASE = {
  generatedAt: '2026-10-02T09:00:00Z',
  expirySoonDays: 10,
  locations: [LOC],
  glofox: [], whatsapp: [], instagram: [], xero: [], ads: [], shelly: [], sms: [],
  agent: [], email: [], unifi: [], climate: [], bca: [], attention: [],
}

describe('IntegrationsHub — plan & wallet strip (C141)', () => {
  it('no billing rows (not an organisation admin): no strip, no "No platform plan", no Manage plan', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={{ ...BASE, billing: [] }} />)
    expect(html).not.toContain('No platform plan')
    expect(html).not.toContain('Manage plan')
    expect(html).not.toContain('Could not load the platform plan')
  })

  it('an organisation admin with an unpinned location still sees "No platform plan"', () => {
    const html = renderToStaticMarkup(
      <IntegrationsHub data={{ ...BASE, billing: [{ locationId: LOC.id, plan: null }] }} canManageBilling />,
    )
    expect(html).toContain('No platform plan')
    expect(html).toContain('Manage plan')
  })
})
