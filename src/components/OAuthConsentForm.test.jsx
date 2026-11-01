// @vitest-environment jsdom
//
// MCP.1 — the browser half of /oauth/consent. Talks to Supabase's OAuth
// server (getAuthorizationDetails / approveAuthorization / denyAuthorization)
// and then sends the browser back to the MCP client.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const oauth = {
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
}
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({ auth: { oauth } }) }))

import OAuthConsentForm from './OAuthConsentForm.jsx'

const DETAILS = {
  authorization_id: 'auth-1',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  client: { id: 'c1', name: 'Claude' },
  user: { id: 'u1', email: 'coach@example.test' },
  scope: '',
}
const OK = { ok: true, reason: null }
const MCP_OFF = 'MCP access is not switched on for your organisation. Ask an organisation admin.'
const NO_ASSISTANT = 'Ask an admin to switch on AI Assistant for you.'

let assign
beforeEach(() => {
  vi.clearAllMocks()
  assign = vi.fn()
  vi.stubGlobal('location', { assign })
  oauth.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null })
  oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=x' }, error: null })
  oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?error=access_denied' }, error: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const form = (eligibility = OK) => render(
  <OAuthConsentForm authorizationId="auth-1" eligibility={eligibility} personName="Casey Coach" />,
)

describe('OAuthConsentForm', () => {
  it('renders the client name and the capability lines', async () => {
    form()
    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(oauth.getAuthorizationDetails).toHaveBeenCalledWith('auth-1')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /approve/i }).disabled).toBe(false)
  })

  it('renders the client name and disables Approve with the reason when the org switch is off', async () => {
    form({ ok: false, reason: 'mcp_disabled' })
    await screen.findByText('Claude')
    expect(screen.getByRole('button', { name: /approve/i }).disabled).toBe(true)
    expect(screen.getByText(MCP_OFF)).toBeTruthy()
    expect(screen.getByRole('button', { name: /deny/i }).disabled).toBe(false)
  })

  it('disables Approve with the reason when the assistant permission is missing', async () => {
    form({ ok: false, reason: 'assistant_permission' })
    await screen.findByText('Claude')
    expect(screen.getByRole('button', { name: /approve/i }).disabled).toBe(true)
    expect(screen.getByText(NO_ASSISTANT)).toBeTruthy()
  })

  it('calls approveAuthorization and assigns the redirect_url', async () => {
    form()
    await screen.findByText('Claude')
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=x'))
    expect(oauth.approveAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true })
  })

  it('calls denyAuthorization and assigns the redirect_url, even when ineligible', async () => {
    form({ ok: false, reason: 'mcp_disabled' })
    await screen.findByText('Claude')
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?error=access_denied'))
    expect(oauth.denyAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true })
  })

  it('follows redirect_url straight away when the client is already approved', async () => {
    oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=already' }, error: null })
    form()
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=already'))
    expect(screen.queryByRole('button', { name: /approve/i })).toBe(null)
  })

  it('shows an error inline when the request cannot be read, and offers no Approve', async () => {
    oauth.getAuthorizationDetails.mockResolvedValue({ data: null, error: { message: 'authorization request expired' } })
    form()
    expect(await screen.findByText(/authorization request expired/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /approve/i })).toBe(null)
    expect(assign).not.toHaveBeenCalled()
  })

  it('shows an error inline and does not navigate when approve fails', async () => {
    oauth.approveAuthorization.mockResolvedValue({ data: null, error: { message: 'boom' } })
    form()
    await screen.findByText('Claude')
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(await screen.findByText(/boom/)).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })

  it('does not call approve when the form is ineligible (button is disabled)', async () => {
    form({ ok: false, reason: 'assistant_permission' })
    await screen.findByText('Claude')
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(oauth.approveAuthorization).not.toHaveBeenCalled()
  })

  it('every button has type="button"', async () => {
    form()
    await screen.findByText('Claude')
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button')
  })
})
