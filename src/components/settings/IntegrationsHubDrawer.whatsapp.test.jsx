// @vitest-environment jsdom
//
// WACONFIGFALLBACK.1 — the hub drawer's WhatsApp panel. There is no env
// fallback any more: a studio with no active number sends and receives no
// WhatsApp. The panel used to say a disconnected number "falls back to
// another number or the env-var default", and its Disconnect confirm used the
// same promise. Disconnecting the LAST active number now says WhatsApp stops
// at this studio. Ids are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ children, href }) => <a href={href}>{children}</a> }))
vi.mock('./integrations/ConnectWhatsAppCard', () => ({ ConnectWhatsAppCard: () => null }))
vi.mock('./integrations/AdsIntegrationTab', () => ({ default: () => null }))
vi.mock('@/components/customer-agent/ConnectionsSection', () => ({ default: () => null }))

import IntegrationsHubDrawer from './IntegrationsHubDrawer.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUM = (over) => ({ id: 'n1', label: 'Front desk', displayPhone: null, isDefault: true, isActive: true, source: 'cloud_api', ...over })
const STOPS = /WhatsApp stops at this studio: Mia stops replying, and booking confirmations and reminders are no longer sent/

function open(numbers) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }))
  render(
    <IntegrationsHubDrawer cardKey="whatsapp" locationId={LOC} locationName="Test Studio"
      initial={{ numbers }} onClose={() => {}} onChanged={() => {}} />,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.fetch })

describe('IntegrationsHubDrawer — WhatsApp panel copy (WACONFIGFALLBACK.1)', () => {
  it('the intro says a studio with no active number has no WhatsApp, never the env-var default', () => {
    open([NUM()])
    expect(screen.getByText(/will not send or receive WhatsApp while it has no active number/)).toBeTruthy()
    expect(screen.queryByText(/env-var default/)).toBeNull()
    expect(screen.queryByText(/falls back/)).toBeNull()
  })

  it('disconnecting the LAST active number warns that WhatsApp stops here; cancel sends nothing', () => {
    open([NUM(), NUM({ id: 'n2', label: 'Old', isDefault: false, isActive: false })])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0])
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toMatch(STOPS)
    expect(confirmSpy.mock.calls[0][0]).not.toMatch(/env/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('disconnecting one of two active numbers says the other keeps working', () => {
    open([NUM(), NUM({ id: 'n2', label: 'Back office', isDefault: false })])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0])
    expect(confirmSpy.mock.calls[0][0]).toMatch(/keeps using its other active number/)
    expect(confirmSpy.mock.calls[0][0]).not.toMatch(STOPS)
  })
})
