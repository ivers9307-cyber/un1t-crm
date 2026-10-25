// @vitest-environment jsdom
//
// WASTUDIOPICK.1 (R9) — the thread header says how the studio was decided.
// studioNote is the pure decision; the render tests pin that the header shows it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({ default: () => <div /> }))
vi.mock('@/components/IGInbox', () => ({ default: () => <div>ig</div> }))

import WAInbox, { studioNote } from './WAInbox.jsx'

const BASE = {
  id: 'conv1',
  location_id: 'loc1',
  wa_phone: '353870000001',
  wa_profile_name: 'Sam Example',
  contact_id: 'ct1',
  contacts: { id: 'ct1', name: 'Sam Example', first_name: 'Sam' },
  unread_count: 0,
  last_message_at: '2026-10-15T10:00:00.000Z',
  last_message_direction: 'inbound',
  last_message_preview: 'hello',
  resolved_at: null,
}
let resolution

function json(body) { return { ok: true, status: 200, json: async () => body } }
function routeFetch(url) {
  const u = String(url)
  const conv = { ...BASE, studio_resolution: resolution }
  if (/\/api\/whatsapp\/conversations\/conv1$/.test(u)) return json({ success: true, conversation: conv, messages: [] })
  if (/\/api\/whatsapp\/conversations(\?|$)/.test(u)) return json({ success: true, conversations: [conv] })
  if (/\/api\/instagram\/conversations(\?|$)/.test(u)) return json({ success: true, conversations: [] })
  return json({ success: true, approvals: [], templates: [] })
}

beforeEach(() => {
  resolution = null
  vi.stubGlobal('fetch', vi.fn(async (url) => routeFetch(url)))
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('studioNote', () => {
  it.each([
    ['ai', 'Filed by: AI'],
    ['picker', 'Filed by: picker'],
    ['ad', 'Filed by: ad'],
    ['reply', 'Filed by: reply'],
    ['staff', 'Filed by: staff'],
  ])('decided by %s → %s', (by, text) => {
    expect(studioNote({ status: 'decided', by })).toBe(text)
  })
  it('asked → "Asked which studio"', () => {
    expect(studioNote({ status: 'asked' })).toBe('Asked which studio')
  })
  it.each([
    [null], [undefined], [{}], [{ status: 'unresolved' }], [{ status: 'decided' }],
    [{ status: 'decided', by: 'mystery' }], [{ status: 'something_new', by: 'ai' }], ['decided'], [42],
  ])('anything else (%j) → nothing', (r) => {
    expect(studioNote(r)).toBeNull()
  })
})

describe('WAInbox — Filed by note', () => {
  async function renderSelected() {
    render(<WAInbox locationId="loc1" initialConversationId="conv1" embedded />)
    await screen.findByTitle('More actions')
  }
  it.each([
    ['ai', 'Filed by: AI'],
    ['picker', 'Filed by: picker'],
    ['ad', 'Filed by: ad'],
    ['reply', 'Filed by: reply'],
    ['staff', 'Filed by: staff'],
  ])('shows "%s" decision as %s', async (by, text) => {
    resolution = { status: 'decided', by, location_id: 'loc1', at: '2026-10-15T10:00:00.000Z' }
    await renderSelected()
    expect(await screen.findByText(text)).toBeTruthy()
  })
  it('shows "Asked which studio" while asked', async () => {
    resolution = { status: 'asked', at: '2026-10-15T10:00:00.000Z' }
    await renderSelected()
    expect(await screen.findByText('Asked which studio')).toBeTruthy()
  })
  it.each([[null], [{ status: 'unresolved' }]])('shows nothing for %j', async (r) => {
    resolution = r
    await renderSelected()
    expect(screen.queryByText(/Filed by|Asked which studio/)).toBeNull()
  })
})
