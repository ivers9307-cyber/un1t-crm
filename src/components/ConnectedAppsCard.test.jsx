// @vitest-environment jsdom
//
// MCP.1 — Connected apps on /account: the grants come from the browser
// client (supabase.auth.oauth.listGrants), usage from our own route, and
// Revoke goes through revokeGrant({ clientId }) after a confirm.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const listGrants = vi.fn()
const revokeGrant = vi.fn()
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({ auth: { oauth: { listGrants, revokeGrant } } }),
}))
vi.mock('@/lib/use-viewer-zone', () => ({ useViewerZone: () => null }))

import ConnectedAppsCard from './ConnectedAppsCard'

const C1 = '20000000-0000-4000-8000-000000000001'
const URL_ = 'https://crm.example.test/api/mcp'
const GRANT = {
  client: { id: C1, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
  scopes: ['openid'],
  granted_at: '2026-10-20T09:00:00.000Z',
}
const USAGE = { success: true, data: { clients: [{ client_id: C1, last_used_at: '2026-10-31T09:30:00.000Z', calls_7d: 12 }] } }

let usageBody
beforeEach(() => {
  listGrants.mockReset()
  revokeGrant.mockReset()
  usageBody = USAGE
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => usageBody })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ConnectedAppsCard', () => {
  it('lists grants with usage and revokes through revokeGrant', async () => {
    listGrants.mockResolvedValueOnce({ data: [GRANT], error: null }).mockResolvedValueOnce({ data: [], error: null })
    revokeGrant.mockResolvedValue({ data: {}, error: null })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ConnectedAppsCard connectorUrl={URL_} />)

    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(await screen.findByText(/12 calls in the last 7 days/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith({ clientId: C1 }))
    expect(window.confirm).toHaveBeenCalled()
    // reloaded: the empty state shows once the list is empty
    expect(await screen.findByText(/Nothing connected/)).toBeTruthy()
    expect(listGrants).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the confirm is declined', async () => {
    listGrants.mockResolvedValue({ data: [GRANT], error: null })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ConnectedAppsCard connectorUrl={URL_} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    expect(revokeGrant).not.toHaveBeenCalled()
  })

  it('shows the empty state with the connector URL', async () => {
    listGrants.mockResolvedValue({ data: [], error: null })
    render(<ConnectedAppsCard connectorUrl={URL_} />)
    expect(await screen.findByText(/Nothing connected/)).toBeTruthy()
    expect(screen.getByText(/https:\/\/crm\.example\.test\/api\/mcp/)).toBeTruthy()
  })

  it('shows a refusal from revokeGrant instead of dropping the row', async () => {
    listGrants.mockResolvedValue({ data: [GRANT], error: null })
    revokeGrant.mockResolvedValue({ data: null, error: { message: 'nope' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConnectedAppsCard connectorUrl={URL_} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Claude')).toBeTruthy()
  })

  it('still lists the grants when usage cannot be read', async () => {
    listGrants.mockResolvedValue({ data: [GRANT], error: null })
    usageBody = { success: false, error: 'x' }
    render(<ConnectedAppsCard connectorUrl={URL_} />)
    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(screen.queryByText(/calls in the last 7 days/)).toBeNull()
  })
})
