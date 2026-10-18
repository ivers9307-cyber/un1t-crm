// @vitest-environment jsdom
//
// WACONFIGFALLBACK.1 / WAORGNUMBER.1 — the hub drawer's WhatsApp panel. There
// is no env fallback any more: a studio with no active number sends and
// receives no WhatsApp. Numbers belong to the organisation, so the panel lists
// them read-only and points at the organisation's page: the Embedded Signup
// card and the per-number Disconnect moved there with their routes. Ids are
// synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ children, href }) => <a href={href}>{children}</a> }))
vi.mock('./integrations/AdsIntegrationTab', () => ({ default: () => null }))
vi.mock('@/components/customer-agent/ConnectionsSection', () => ({ default: () => null }))

import IntegrationsHubDrawer from './IntegrationsHubDrawer.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUM = (over) => ({ id: 'n1', label: 'Front desk', displayPhone: null, isDefault: true, isActive: true, source: 'cloud_api', ...over })

function open(numbers) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }))
  render(
    <IntegrationsHubDrawer cardKey="whatsapp" locationId={LOC} locationName="Test Studio"
      initial={{ numbers }} onClose={() => {}} onChanged={() => {}} />,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.fetch })

describe('IntegrationsHubDrawer — WhatsApp panel (WACONFIGFALLBACK.1, WAORGNUMBER.1)', () => {
  it('the intro says a studio with no active number has no WhatsApp, never the env-var default', () => {
    open([NUM()])
    expect(screen.getByText(/will not send or receive WhatsApp while it has no active number/)).toBeTruthy()
    expect(screen.queryByText(/env-var default/)).toBeNull()
    expect(screen.queryByText(/falls back/)).toBeNull()
  })

  it('lists the numbers read-only and links to the organisation page', () => {
    open([NUM(), NUM({ id: 'n2', label: 'Old', isDefault: false, isActive: false })])
    expect(screen.getByText('Front desk')).toBeTruthy()
    expect(screen.getByText(/Old/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'WhatsApp numbers' }).getAttribute('href')).toBe('/settings/whatsapp-numbers')
  })

  it('offers no Disconnect and no Connect: those routes moved to the organisation', () => {
    open([NUM()])
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull()
    expect(screen.queryByText('Connect with WhatsApp')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
