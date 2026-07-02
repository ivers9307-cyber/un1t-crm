// MIA-CARDS.1 — unit tests for the shared card-set send helper (used by
// both the inbox send-carousel route and the agent's send_card_set tool).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendMediaCarousel: vi.fn(async () => ({ messageId: 'wamid.CAROUSEL1' })),
}))

import { sendCardSetToConversation } from './whatsapp-carousel-send'
import { sendMediaCarousel } from '@/lib/whatsapp'

const SET = {
  id: 'cs1',
  name: 'Membership',
  body_text: 'Our membership options',
  cards: [
    { image_url: 'https://cdn.test/1.jpg', title: 'Unlimited' },
    { image_url: 'https://cdn.test/2.jpg', title: 'Off-peak' },
  ],
}
const CONVERSATION = { id: 'conv1', contact_id: 'ct1', wa_phone: '353871234567' }

function makeDb() {
  const inserts = []
  const db = {
    from: (table) => ({
      insert: async (row) => { inserts.push({ table, row }) },
    }),
  }
  return { db, inserts }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendCardSetToConversation', () => {
  it('sends the carousel and inserts a carousel thread row with the wamid', async () => {
    const { db, inserts } = makeDb()
    const result = await sendCardSetToConversation(db, { set: SET, conversation: CONVERSATION, locationId: 'loc1' })

    expect(result).toEqual({ messageId: 'wamid.CAROUSEL1' })
    expect(sendMediaCarousel).toHaveBeenCalledWith(
      '353871234567',
      { bodyText: 'Our membership options', cards: SET.cards },
      { locationId: 'loc1' },
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('whatsapp_messages')
    expect(inserts[0].row).toMatchObject({
      conversation_id: 'conv1',
      contact_id: 'ct1',
      location_id: 'loc1',
      wa_message_id: 'wamid.CAROUSEL1',
      direction: 'outbound',
      message_type: 'carousel',
      body: '[Card set: Membership]',
      status: 'sent',
    })
  })

  it('omits source from the row when not provided (staff/inbox path stays byte-identical)', async () => {
    const { db, inserts } = makeDb()
    await sendCardSetToConversation(db, { set: SET, conversation: CONVERSATION, locationId: 'loc1' })
    expect('source' in inserts[0].row).toBe(false)
  })

  it('stamps the row with the given source (agent path)', async () => {
    const { db, inserts } = makeDb()
    await sendCardSetToConversation(db, { set: SET, conversation: CONVERSATION, locationId: 'loc1', source: 'agent' })
    expect(inserts[0].row.source).toBe('agent')
  })

  it('falls back to the set name as bodyText when body_text is empty', async () => {
    const { db } = makeDb()
    const { body_text: _omit, ...bare } = SET
    await sendCardSetToConversation(db, { set: bare, conversation: CONVERSATION, locationId: 'loc1' })
    expect(sendMediaCarousel).toHaveBeenCalledWith(
      '353871234567',
      { bodyText: 'Membership', cards: SET.cards },
      { locationId: 'loc1' },
    )
  })

  it('a thread-row insert failure never fails a send Meta already accepted', async () => {
    const db = { from: () => ({ insert: async () => { throw new Error('constraint violation') } }) }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await sendCardSetToConversation(db, { set: SET, conversation: CONVERSATION, locationId: 'loc1' })
    expect(result).toEqual({ messageId: 'wamid.CAROUSEL1' })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('propagates a Meta send failure to the caller (route → 502, tool → error result)', async () => {
    sendMediaCarousel.mockRejectedValueOnce(new Error('Meta 400: outside window'))
    const { db, inserts } = makeDb()
    await expect(
      sendCardSetToConversation(db, { set: SET, conversation: CONVERSATION, locationId: 'loc1' }),
    ).rejects.toThrow('outside window')
    expect(inserts).toHaveLength(0)
  })
})
