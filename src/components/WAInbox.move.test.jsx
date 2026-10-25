// @vitest-environment jsdom
//
// WAHOMESTUDIO.1 (R7) — "Move to <studio>" from the inbox overflow menu.
//
// WAInbox clears its OWN selection after a move, but in the unified inbox the
// parent (UnifiedInbox) owns the queue and the selected thread, so WAInbox
// reports the move through `onMoved(conversationId)` and UnifiedInbox drops
// its selection (thread pane, command centre, mobile back bar) and reloads
// the queue. Pinned at both levels. No layout is involved: the checks are the
// callback, and which pane UnifiedInbox renders.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({
  default: ({ conversationId }) => <div data-testid="command-centre">{conversationId}</div>,
}))
vi.mock('@/components/IGInbox', () => ({ default: () => <div>ig</div> }))

import WAInbox from './WAInbox.jsx'
import UnifiedInbox from './UnifiedInbox.jsx'

const CONV = {
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

let moveResponse
let moveTargets
let listCalls
let listBody

function json(body) { return { ok: true, status: 200, json: async () => body } }

function routeFetch(url, init) {
  const u = String(url)
  if (/\/conversations\/conv1\/move$/.test(u)) {
    if (init?.method === 'POST') return json(moveResponse)
    return json({ success: true, data: { targets: moveTargets } })
  }
  if (/\/api\/whatsapp\/conversations\/conv1$/.test(u)) {
    return json({ success: true, conversation: CONV, messages: [] })
  }
  if (/\/api\/whatsapp\/conversations(\?|$)/.test(u)) {
    listCalls += 1
    return json({ success: true, conversations: listBody })
  }
  if (/\/api\/instagram\/conversations(\?|$)/.test(u)) return json({ success: true, conversations: [] })
  return json({ success: true, approvals: [], templates: [] })
}

beforeEach(() => {
  moveResponse = { success: true, data: { conversation_id: 'conv1', merged: false } }
  moveTargets = [{ id: 'loc2', name: 'Hatch Street', whatsapp: true }]
  listCalls = 0
  listBody = [CONV]
  vi.stubGlobal('fetch', vi.fn(async (url, init) => routeFetch(url, init)))
  vi.stubGlobal('confirm', vi.fn(() => true))
  window.confirm = vi.fn(() => true)
  window.alert = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function moveFromMenu() {
  fireEvent.click(await screen.findByTitle('More actions'))
  fireEvent.click(await screen.findByRole('menuitem', { name: /move to hatch street/i }))
}

describe('WAInbox — Move to studio', () => {
  it('calls onMoved with the conversation id after a successful move', async () => {
    const onMoved = vi.fn()
    render(<WAInbox locationId="loc1" initialConversationId="conv1" embedded onMoved={onMoved} />)
    await moveFromMenu()
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith('conv1'))
    expect(window.confirm).toHaveBeenCalled()
  })

  it('does not call onMoved when the move is refused', async () => {
    moveResponse = { success: false, error: 'nope' }
    const onMoved = vi.fn()
    render(<WAInbox locationId="loc1" initialConversationId="conv1" embedded onMoved={onMoved} />)
    await moveFromMenu()
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('nope'))
    expect(onMoved).not.toHaveBeenCalled()
  })

  // WAMOVENUMBER.1 — a studio with no WhatsApp number switched on is shown,
  // disabled and saying why, instead of a move the server would refuse.
  it('a target with no WhatsApp number switched on is disabled and says why; clicking it does nothing', async () => {
    moveTargets = [{ id: 'loc2', name: 'Hatch Street', whatsapp: false }]
    const onMoved = vi.fn()
    render(<WAInbox locationId="loc1" initialConversationId="conv1" embedded onMoved={onMoved} />)
    fireEvent.click(await screen.findByTitle('More actions'))
    const item = await screen.findByRole('menuitem', { name: /move to hatch street/i })
    expect(item.disabled).toBe(true)
    expect(item.textContent).toMatch(/no WhatsApp number/i)
    fireEvent.click(item)
    expect(window.confirm).not.toHaveBeenCalled()
    expect(fetch.mock.calls.some(([url, init]) => init?.method === 'POST' && /\/move$/.test(String(url)))).toBe(false)
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('works standalone (no onMoved prop)', async () => {
    render(<WAInbox locationId="loc1" initialConversationId="conv1" embedded />)
    await moveFromMenu()
    await waitFor(() => expect(screen.queryByTitle('More actions')).toBeNull())
  })
})

describe('UnifiedInbox — a moved thread is dropped from the selection', () => {
  it('clears the selection (thread pane + command centre) and reloads the queue', async () => {
    render(<UnifiedInbox locationId="loc1" userId="u1" initialConversationId="conv1" initialChannel="wa" />)
    // Selected: the embedded thread and the command centre show conv1.
    expect(await screen.findByTestId('command-centre')).toBeTruthy()
    const before = listCalls
    listBody = [] // the server no longer lists it at this studio

    await moveFromMenu()

    await waitFor(() => expect(screen.queryByTestId('command-centre')).toBeNull())
    expect(screen.getByText('Select a conversation')).toBeTruthy()
    await waitFor(() => expect(listCalls).toBeGreaterThan(before))
  })
})
