// IG-SEEN.1 — replying through the API is not a read receipt, so the CRM has
// to send Meta an explicit mark_seen or a thread staff already answered stays
// bold in the Instagram app. It is a courtesy signal on an already-delivered
// message, so every failure path here must stay silent rather than surface.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./channels', () => ({
  resolveLocationByExternalAccount: vi.fn(),
  isAgentEnabledForConnection: vi.fn(() => true),
  IG_GRAPH_URL: 'https://graph.instagram.com/v25.0',
}))
vi.mock('./auto-reply', () => ({ runChannelAgent: vi.fn() }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/connection-health', () => ({
  stampConnectionOk: vi.fn(), stampConnectionError: vi.fn(), isMetaAuthError: vi.fn(() => false),
}))
vi.mock('@/lib/instagram-media-server', () => ({ ensureInstagramMediaRehosted: vi.fn() }))
vi.mock('@/lib/instagram-contact-link-server', () => ({ resolveContactForInstagramThread: vi.fn() }))

import { markInstagramSeen } from './instagram'

const connection = { id: 'conn-1', access_token: 'IGAA-token', external_account_id: '17841449661114656' }

describe('markInstagramSeen', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('posts mark_seen for the customer, on the account, with a bearer token', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    expect(await markInstagramSeen('CUST_IGSID', { connection })).toBe(true)

    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('https://graph.instagram.com/v25.0/17841449661114656/messages')
    expect(init.headers.Authorization).toBe('Bearer IGAA-token')
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: 'CUST_IGSID' },
      sender_action: 'mark_seen',
    })
  })

  it('does nothing without a token or a recipient', async () => {
    expect(await markInstagramSeen('CUST', { connection: {} })).toBe(false)
    expect(await markInstagramSeen(null, { connection })).toBe(false)
    expect(await markInstagramSeen('CUST', {})).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('reports failure quietly when Meta rejects it', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'outside window' } }) })
    expect(await markInstagramSeen('CUST', { connection })).toBe(false)
  })

  it('never throws when the network does', async () => {
    global.fetch.mockRejectedValue(new Error('socket hang up'))
    await expect(markInstagramSeen('CUST', { connection })).resolves.toBe(false)
  })
})
