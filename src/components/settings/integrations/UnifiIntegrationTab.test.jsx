// @vitest-environment jsdom
// SECFIX.3b — the UniFi tab never reads or writes locations from the browser.
// It saves through the masked, service-role PUT
// /api/locations/[id]/integrations/unifi; the API token is write-only.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))
const browserClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ createBrowserClient: browserClient }))

import UnifiIntegrationTab from './UnifiIntegrationTab.jsx'
import { LOCATION_SECRET_MASK } from '@/lib/location-secrets'

const LOC = {
  id: 'a0000000-0000-4000-8000-000000000002', name: 'Test Studio',
  settings: { unifi: { host: 'https://u.example', api_token: LOCATION_SECRET_MASK, staff_policy_id: 's1', manager_policy_id: 'm1', allow_self_signed: false } },
}

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true, data: { has_token: true } }) }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); browserClient.mockReset() })

const putCall = () => fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')

describe('UnifiIntegrationTab (SECFIX.3b)', () => {
  it('the API Token input starts blank with "Saved (hidden)"; the mask is never shown', () => {
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    const input = screen.getByLabelText('API Token')
    expect(input.value).toBe('')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('placeholder')).toMatch(/Saved \(hidden\)/)
    expect(document.body.innerHTML).not.toContain(LOCATION_SECRET_MASK)
  })

  // S1 — autocomplete="off" is ignored by password managers; an autofilled
  // login would be saved as the UniFi token. "new-password" blocks the fill.
  it('the API Token input is autocomplete="new-password" (a password manager must not fill it)', () => {
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    const pw = document.querySelectorAll('input[type="password"]')
    expect(pw.length).toBe(1)
    expect(pw[0].getAttribute('autocomplete')).toBe('new-password')
  })

  // N3 — "Currently set" / "Not set" describes the blank token input.
  const statusOf = (input) => {
    const id = input.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    return document.getElementById(id)?.textContent || ''
  }

  it('the API Token input is described as "Currently set" when stored and "Not set" when not', () => {
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    expect(statusOf(screen.getByLabelText('API Token'))).toMatch(/^Currently set/)
    cleanup()
    render(<UnifiIntegrationTab location={{ ...LOC, settings: { unifi: { host: 'https://u.example' } } }} canEdit />)
    expect(statusOf(screen.getByLabelText('API Token'))).toMatch(/^Not set/)
  })

  it('an untouched save PUTs the non-secret fields and no api_token', async () => {
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    const [url, init] = putCall()
    expect(url).toBe(`/api/locations/${LOC.id}/integrations/unifi`)
    const body = JSON.parse(init.body)
    expect(body).toEqual({ host: 'https://u.example', staff_policy_id: 's1', manager_policy_id: 'm1', allow_self_signed: false })
    expect(browserClient).not.toHaveBeenCalled()
  })

  it('a typed token is sent, trimmed', async () => {
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    fireEvent.change(screen.getByLabelText('API Token'), { target: { value: ' NEW-TOKEN ' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    expect(JSON.parse(putCall()[1].body).api_token).toBe('NEW-TOKEN')
  })

  it('a failed save shows the route\'s error', async () => {
    fetchMock.mockImplementation(async (url, init) => init?.method === 'PUT'
      ? { ok: false, status: 403, json: async () => ({ success: false, error: 'Forbidden: master only' }) }
      : { ok: true, status: 200, json: async () => ({ success: true }) })
    render(<UnifiIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(await screen.findByText('Forbidden: master only')).toBeTruthy()
  })
})
