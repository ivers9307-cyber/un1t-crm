// @vitest-environment jsdom
// SECFIX.3b — the Twilio tab never writes locations from the browser. It
// saves the alpha sender ID through the service-role PUT
// /api/locations/[id]/integrations/twilio, keeping its inline validation.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))
const browserClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ createBrowserClient: browserClient }))

import TwilioIntegrationTab from './TwilioIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000003', name: 'Test Studio', twilio_alpha_sender_id: 'UN1T' }

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { connected: true, sender_id: 'UN1T' } }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); browserClient.mockReset() })

const putCall = () => fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')

describe('TwilioIntegrationTab (SECFIX.3b)', () => {
  it('Save PUTs the sender ID to the location\'s route and never uses the browser client', async () => {
    render(<TwilioIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    const [url, init] = putCall()
    expect(url).toBe(`/api/locations/${LOC.id}/integrations/twilio`)
    expect(JSON.parse(init.body)).toEqual({ sender_id: 'UN1T' })
    expect(browserClient).not.toHaveBeenCalled()
  })

  // S1 — the sender ID is not a credential, so this tab has no password input
  // for a password manager to fill (the Glofox and UniFi tabs pin theirs).
  it('has no credential input', () => {
    render(<TwilioIntegrationTab location={LOC} canEdit />)
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0)
  })

  it('an invalid sender ID shows the inline error and makes no PUT', async () => {
    render(<TwilioIntegrationTab location={LOC} canEdit />)
    fireEvent.change(screen.getByLabelText('Alpha Sender ID'), { target: { value: 'x'.repeat(12) } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(await screen.findByText(/Sender ID:/)).toBeTruthy()
    expect(putCall()).toBeUndefined()
  })

  it('a route error is shown', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Sender ID: rejected by the route' }) }))
    render(<TwilioIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(await screen.findByText('Sender ID: rejected by the route')).toBeTruthy()
  })
})
