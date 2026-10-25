// WAREPLYNUMBER.1 (C86) — Mia's in-thread confirmations (an approved booking,
// a cancellation, a decline) go from the number the customer wrote to, like
// her live replies: sendAgentThreadMessage names the conversation, and the
// sender resolves its recorded number (else the studio default).
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.CONF1' })),
  isWindowOpen: vi.fn(() => true),
}))

import { sendAgentThreadMessage } from './notify'
import { sendTextMessage } from '@/lib/whatsapp'

const CONV = 'c0000000-0000-4000-8000-000000000001'
const LOC = 'a0000000-0000-4000-8000-000000000001'

function fakeDb() {
  const inserts = []
  return {
    inserts,
    from(table) {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: { id: CONV, location_id: LOC, wa_phone: '15555550100', window_expires_at: '2999-01-01T00:00:00Z', contact_id: null, contacts: null },
          error: null,
        }),
        insert: async (row) => { inserts.push({ table, row }); return { error: null } },
      }
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('sendAgentThreadMessage (WhatsApp) — the reply number', () => {
  it('sends from the thread number: names the conversation', async () => {
    const db = fakeDb()
    const out = await sendAgentThreadMessage(db, { channel: 'whatsapp', conversationId: CONV, text: 'You are booked in.' })
    expect(out).toEqual({ sent: true })
    expect(sendTextMessage).toHaveBeenCalledWith('15555550100', 'You are booked in.', { locationId: LOC, replyInConversation: CONV })
  })
})
