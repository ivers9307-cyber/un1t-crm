// @vitest-environment jsdom
// APPROVALSQ.3 — WAInbox and IGInbox hand the studio's zone to the approval card
// they render inside a thread.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({ default: () => <div /> }))
vi.mock('@/components/ApprovalActionCard', () => ({ default: ({ timezone }) => <div data-testid="approval" data-tz={timezone ?? ''} /> }))

import WAInbox from './WAInbox.jsx'
import IGInbox from './IGInbox.jsx'

const REQ = { id: 'r1', kind: 'pause', status: 'pending', details: {}, created_at: '2026-11-14T10:00:00Z' }
const WA = {
  id: 'conv1', location_id: 'loc1', wa_phone: '353870000001', wa_profile_name: 'Sam Example', contact_id: 'ct1',
  contacts: { id: 'ct1', name: 'Sam Example', first_name: 'Sam' }, unread_count: 0,
  last_message_at: '2026-10-15T10:00:00.000Z', last_message_direction: 'inbound', last_message_preview: 'hello', resolved_at: null,
}
const IG = {
  id: 'conv1', location_id: 'loc1', ig_user_id: '1', ig_username: 'someone', contact_id: null, contacts: null, unread_count: 0,
  agent_active: true, last_message_at: '2026-08-19T10:00:00.000Z', last_message_direction: 'inbound', last_message_preview: 'hi', resolved_at: null,
}
const json = (body) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/agent/membership-requests')) return json({ success: true, requests: [REQ] })
    if (/\/api\/whatsapp\/conversations\/conv1$/.test(u)) return json({ success: true, conversation: WA, messages: [] })
    if (/\/api\/whatsapp\/conversations(\?|$)/.test(u)) return json({ success: true, conversations: [WA] })
    if (/\/api\/instagram\/conversations\/conv1$/.test(u)) return json({ success: true, conversation: IG, messages: [] })
    if (/\/api\/instagram\/conversations(\?|$)/.test(u)) return json({ success: true, conversations: [IG] })
    return json({ success: true, approvals: [], templates: [] })
  }))
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('approval card timezone threading', () => {
  it('WAInbox passes timezone to ApprovalActionCard', async () => {
    render(<WAInbox locationId="loc1" timezone="America/New_York" initialConversationId="conv1" embedded />)
    expect((await screen.findByTestId('approval')).getAttribute('data-tz')).toBe('America/New_York')
  })
  it('IGInbox passes timezone to ApprovalActionCard', async () => {
    render(<IGInbox locationId="loc1" timezone="America/New_York" initialConversationId="conv1" embedded />)
    expect((await screen.findByTestId('approval')).getAttribute('data-tz')).toBe('America/New_York')
  })
})
