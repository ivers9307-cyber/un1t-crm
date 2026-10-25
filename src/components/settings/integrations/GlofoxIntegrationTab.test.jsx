// @vitest-environment jsdom
// SECFIX.3b — the Glofox tab never reads or writes locations from the browser.
// It saves through the masked, service-role PUT
// /api/locations/[id]/integrations/glofox, and its credentials are
// write-only: the page hands it masked values, the inputs start blank, and
// only what the operator types is sent.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))
const browserClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ createBrowserClient: browserClient }))

import GlofoxIntegrationTab from './GlofoxIntegrationTab.jsx'
import { LOCATION_SECRET_MASK } from '@/lib/location-secrets'

const LOC = {
  id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio',
  settings: { glofox: { branch_id: 'b1', api_key: LOCATION_SECRET_MASK, api_token: LOCATION_SECRET_MASK, webhook_secret: LOCATION_SECRET_MASK, namespace: 'ns', trial_membership_id: 'm1', trial_plan_code: 'p1' } },
}

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true, data: { has_api_key: true, has_api_token: true, has_webhook_secret: true } }) }
    return { ok: true, status: 200, json: async () => ({ success: true, memberships: [], data: { trainers: [] } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); browserClient.mockReset() })

const putCall = () => fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')

describe('GlofoxIntegrationTab (SECFIX.3b)', () => {
  it('secret inputs start blank with "Saved (hidden)"; the mask is never shown', () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    for (const label of ['API Key', 'API Token', 'Webhook Secret']) {
      const input = screen.getByLabelText(label)
      expect(input.value).toBe('')
      expect(input.getAttribute('type')).toBe('password')
      expect(input.getAttribute('placeholder')).toMatch(/Saved \(hidden\)/)
    }
    expect(document.body.innerHTML).not.toContain(LOCATION_SECRET_MASK)
  })

  // S1 — a password manager ignores autocomplete="off" and would fill a saved
  // CRM login into a blank password field; any non-blank value is sent as a
  // new secret, so one unrelated Save would overwrite the live Glofox key.
  // "new-password" is the value managers honour (no fill).
  it('every credential input is autocomplete="new-password" (a password manager must not fill it)', () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    const pw = document.querySelectorAll('input[type="password"]')
    expect(pw.length).toBe(3)
    for (const input of pw) expect(input.getAttribute('autocomplete')).toBe('new-password')
  })

  // N3 — the blank input alone cannot say whether a credential is stored (the
  // placeholder is not announced reliably), so each one is described by a
  // "Currently set" / "Not set" line, as the Integrations hub drawer shows.
  const statusOf = (input) => {
    const id = input.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    return document.getElementById(id)?.textContent || ''
  }

  it('each credential input is described as "Currently set" when stored', () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    for (const label of ['API Key', 'API Token', 'Webhook Secret']) {
      expect(statusOf(screen.getByLabelText(label))).toMatch(/^Currently set/)
    }
  })

  it('each credential input is described as "Not set" when nothing is stored, and flips after a save', async () => {
    const bare = { ...LOC, settings: { glofox: { branch_id: 'b1' } } }
    fetchMock.mockImplementation(async (url, init) => init?.method === 'PUT'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { has_api_key: true, has_api_token: false, has_webhook_secret: false } }) }
      : { ok: true, status: 200, json: async () => ({ success: true, memberships: [], data: { trainers: [] } }) })
    render(<GlofoxIntegrationTab location={bare} canEdit />)
    for (const label of ['API Key', 'API Token', 'Webhook Secret']) {
      expect(statusOf(screen.getByLabelText(label))).toMatch(/^Not set/)
    }
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'NEW-KEY' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(statusOf(screen.getByLabelText('API Key'))).toMatch(/^Currently set/))
    expect(statusOf(screen.getByLabelText('API Token'))).toMatch(/^Not set/)
  })

  it('a stored key still loads the trial-membership picker (presence, not value)', async () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `/api/locations/${LOC.id}/glofox-memberships`)).toBe(true))
  })

  it('an untouched save PUTs the non-secret fields and NO secret key', async () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    const [url, init] = putCall()
    expect(url).toBe(`/api/locations/${LOC.id}/integrations/glofox`)
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ branch_id: 'b1', namespace: 'ns', trial_membership_id: 'm1', trial_plan_code: 'p1' })
    expect(body).not.toHaveProperty('api_key')
    expect(body).not.toHaveProperty('api_token')
    expect(body).not.toHaveProperty('webhook_secret')
    expect(JSON.stringify(body)).not.toContain(LOCATION_SECRET_MASK)
    expect(browserClient).not.toHaveBeenCalled()
  })

  it('a typed secret is sent, trimmed', async () => {
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  NEW-KEY  ' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    expect(JSON.parse(putCall()[1].body).api_key).toBe('NEW-KEY')
  })

  it('a failed save shows the route\'s error', async () => {
    fetchMock.mockImplementation(async (url, init) => init?.method === 'PUT'
      ? { ok: false, status: 403, json: async () => ({ success: false, error: 'Forbidden' }) }
      : { ok: true, status: 200, json: async () => ({ success: true, memberships: [] }) })
    render(<GlofoxIntegrationTab location={LOC} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    expect(await screen.findByText('Forbidden')).toBeTruthy()
  })
})
