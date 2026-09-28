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
