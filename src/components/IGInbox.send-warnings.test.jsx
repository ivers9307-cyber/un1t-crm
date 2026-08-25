// @vitest-environment jsdom
//
// IGInbox — the operator sees the send route's `warnings`.
//
// POST /api/instagram/conversations/[id]/send returns `{ success: true,
// warnings: [...] }` when Meta HAS delivered the DM but the bookkeeping after
// it failed: the `instagram_messages` row (so the operator's own reply never
// appears in the thread) or the take-over stamp (so Mia is still active on a
// thread a human just took over). BAREWRITE.1 added that array; NOTHING read
// it, in this component or anywhere else, so the route was warning into a
// vacuum and the PR claimed a surface that did not exist.
//
// Both warnings describe a state an operator will otherwise act on wrongly —
// retyping a message the customer already received, or walking away from a
// thread Mia is about to answer. So they are shown.

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

import IGInbox from './IGInbox.jsx'

const CONV = {
  id: 'conv1',
  location_id: 'loc1',
  ig_user_id: '178414',
  ig_username: 'someone',
  contact_id: null,
  contacts: null,
  unread_count: 0,
  agent_active: true,
  last_message_at: '2026-08-19T10:00:00.000Z',
  last_message_direction: 'inbound',
  last_message_preview: 'hello',
  resolved_at: null,
}

let sendResponse

function routeFetch(url, init) {
  const u = String(url)
  if (init?.method === 'POST' && u.endsWith('/send')) {
    return { ok: true, status: 200, json: async () => sendResponse }
  }
  if (/\/api\/instagram\/conversations\/conv1$/.test(u)) {
    return { ok: true, status: 200, json: async () => ({ success: true, conversation: CONV, messages: [] }) }
  }
  if (/\/api\/instagram\/conversations(\?|$)/.test(u)) {
    return { ok: true, status: 200, json: async () => ({ success: true, conversations: [CONV] }) }
  }
  // approvals + anything else
  return { ok: true, status: 200, json: async () => ({ success: true, approvals: [] }) }
}

beforeEach(() => {
  sendResponse = { success: true, messageId: 'mid1', agent_active: false }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => routeFetch(url, init)))
  // jsdom has no layout, so Element.scrollIntoView is undefined.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function sendOne(text = 'hi there') {
  render(<IGInbox locationId="loc1" initialConversationId="conv1" embedded />)
  const input = await screen.findByPlaceholderText(/reply on instagram/i)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input.closest('form'))
}

describe('IGInbox — send warnings reach the operator', () => {
  it('shows the warning when the DM was delivered but the thread row was lost', async () => {
    sendResponse = {
      success: true,
      messageId: 'mid1',
      agent_active: false,
      warnings: ['The message was delivered but could not be saved to the thread — do not resend it.'],
    }

    await sendOne()

    // THE REGRESSION: nothing rendered this, so the operator saw a reply that
    // had vanished from the thread and retyped it.
    await waitFor(() => {
      expect(screen.getByText(/could not be saved to the thread/i)).toBeTruthy()
    })
  })

  it('shows the warning when Mia could not be paused on the thread', async () => {
    sendResponse = {
      success: true,
      messageId: 'mid1',
      agent_active: true,
      warnings: ['The message was delivered but Mia could not be paused on this thread — pause her manually.'],
    }

    await sendOne()

    await waitFor(() => {
      expect(screen.getByText(/Mia could not be paused/i)).toBeTruthy()
    })
  })

  it('shows nothing on a clean send', async () => {
    await sendOne()

    await waitFor(() => {
      expect(screen.queryByText(/could not be saved to the thread/i)).toBeNull()
      expect(screen.queryByText(/Mia could not be paused/i)).toBeNull()
    })
  })
})
