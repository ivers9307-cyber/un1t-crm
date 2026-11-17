// @vitest-environment jsdom
//
// ESCOEXIST.1 — the Embedded Signup launch options. Meta's coexistence
// sample ("Onboarding WhatsApp Business app users", ES v4) carries
// `featureType` AND `sessionInfoVersion: '3'`; without the latter the
// dialog showed only the new-number choices and a Business-app number
// failed with "This phone number is already registered".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

import { ConnectWhatsAppCard } from './ConnectWhatsAppCard.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }

function setup() {
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ success: true, data: { configured: true, app_id: 'app1', config_id: 'cfg1' } }),
  }))
  const login = vi.fn((cb) => cb({}))               // dialog abandoned: no code, no POST
  window.FB = { login, init: vi.fn() }
  render(<ConnectWhatsAppCard organizationId="org1" locations={[LOC]} canEdit />)
  return login
}

afterEach(() => { cleanup(); delete window.FB; vi.restoreAllMocks() })

describe('ConnectWhatsAppCard launch options', () => {
  it('coexistence asks for Business app onboarding with session info v3', async () => {
    const login = setup()
    const btn = await screen.findByRole('button', { name: /connect existing number/i })
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    expect(login.mock.calls[0][1]).toEqual({
      config_id: 'cfg1',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
    })
  })

  it('the plain Connect button stays on the Cloud API flow', async () => {
    const login = setup()
    const btn = await screen.findByRole('button', { name: /^connect$/i })
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    expect(login.mock.calls[0][1].extras).toEqual({ setup: {} })
  })
})
