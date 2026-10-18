// @vitest-environment jsdom
//
// WACONFIGFALLBACK.1 / WAORGNUMBER.1 — the hub drawer's WhatsApp panel. There
// is no env fallback any more: a studio with no active number sends and
// receives no WhatsApp. Numbers belong to the organisation, so the panel lists
// them with the studio's on/off switch and default (Task 6) and points at the
// organisation's page: the Embedded Signup card and the per-number Disconnect
// moved there with their routes. Ids are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ children, href }) => <a href={href}>{children}</a> }))
vi.mock('./integrations/AdsIntegrationTab', () => ({ default: () => null }))
vi.mock('@/components/customer-agent/ConnectionsSection', () => ({ default: () => null }))

import IntegrationsHubDrawer from './IntegrationsHubDrawer.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUM = (over) => ({ id: 'n1', label: 'Front desk', display_phone: null, is_default: true, is_active: true, on: true, ...over })

function open(numbers) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { numbers } }) }))
  render(
    <IntegrationsHubDrawer cardKey="whatsapp" locationId={LOC} locationName="Test Studio"
      initial={{ numbers: [] }} onClose={() => {}} onChanged={() => {}} />,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.fetch })

describe('IntegrationsHubDrawer — WhatsApp panel (WACONFIGFALLBACK.1, WAORGNUMBER.1)', () => {
  it('the intro says a studio with no active number has no WhatsApp, never the env-var default', async () => {
    open([NUM()])
    await screen.findByText('Front desk')
    expect(screen.getByText(/will not send or receive WhatsApp while it has no active number/)).toBeTruthy()
    expect(screen.queryByText(/env-var default/)).toBeNull()
    expect(screen.queryByText(/falls back/)).toBeNull()
  })

  it('lists the organisation numbers with a switch and links to the organisation page', async () => {
    open([NUM(), NUM({ id: 'n2', label: 'Old', is_default: false, is_active: false, on: false })])
    expect(await screen.findByText('Front desk')).toBeTruthy()
    expect(screen.getByText(/Old/)).toBeTruthy()
    expect(screen.getByLabelText('Switch on Front desk at this studio').checked).toBe(true)
    expect(screen.getByLabelText('Switch on Old at this studio').checked).toBe(false)
    expect(screen.getByRole('link', { name: 'WhatsApp numbers' }).getAttribute('href')).toBe('/settings/whatsapp-numbers')
  })

  it('offers no Disconnect and no Connect: those routes moved to the organisation', async () => {
    open([NUM()])
    await screen.findByText('Front desk')
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull()
    expect(screen.queryByText('Connect with WhatsApp')).toBeNull()
    // The only call is the studio's numbers read.
    expect(global.fetch.mock.calls.map(([u, init]) => `${init?.method || 'GET'} ${u}`)).toEqual([`GET /api/locations/${LOC}/whatsapp/numbers`])
  })
})
