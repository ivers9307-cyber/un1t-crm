// MIA-CARDS.1 — unit tests for the send_card_set agent tool. The shared
// send helper is mocked (its own IO is covered in
// whatsapp-carousel-send.test.js); what's under test here is the tool
// registry + the executor's guards and result shapes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp-carousel-send', () => ({
  sendCardSetToConversation: vi.fn(async () => ({ messageId: 'wamid.CARD1' })),
}))

import { CARD_TOOLS, CARD_TOOL_NAMES, executeCardTool } from './card-tools'
import { sendCardSetToConversation } from '@/lib/whatsapp-carousel-send'

const SETS = [
  {
    id: 'cs1',
    name: 'Membership',
    description: 'When someone asks about membership options or pricing',
    cards: [
      { image_url: 'https://cdn.test/1.jpg', title: 'Unlimited' },
      { image_url: 'https://cdn.test/2.jpg', title: 'Off-peak' },
    ],
  },
  {
    id: 'cs2',
    name: 'Studio tour',
    cards: [
      { image_url: 'https://cdn.test/3.jpg', title: 'Floor' },
      { image_url: 'https://cdn.test/4.jpg', title: 'Rig' },
    ],
  },
]

// Minimal chainable fake for the three reads the executor performs:
// locations.settings, the carousel-count guard, and the conversation row.
function makeDb({
  sets = SETS,
  carouselCount = 0,
  conversation = { id: 'conv1', contact_id: 'ct1', wa_phone: '353871234567' },
} = {}) {
  return {
    from(table) {
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: { wa_card_sets: sets } } }) }) }) }
      }
      if (table === 'whatsapp_messages') {
        const chain = {
          eq: () => chain,
          then: (resolve) => resolve({ count: carouselCount }),
        }
        return { select: () => chain }
      }
      if (table === 'whatsapp_conversations') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conversation }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
}

function ctx(overrides = {}) {
  return {
    db: makeDb(),
    conversationId: 'conv1',
    locationId: 'loc1',
    channel: 'whatsapp',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CARD_TOOLS registry', () => {
  it('declares send_card_set with a required set_name', () => {
    expect(CARD_TOOLS.map(t => t.name)).toEqual(['send_card_set'])
    expect(CARD_TOOLS[0].input_schema.required).toEqual(['set_name'])
    expect(CARD_TOOL_NAMES.has('send_card_set')).toBe(true)
  })
})

describe('executeCardTool', () => {
  it('refuses non-WhatsApp channels without touching the db or sending', async () => {
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx({ channel: 'instagram', db: { from: () => { throw new Error('db should not be hit') } } }))
    expect(result.error).toBe('wrong_channel')
    expect(result.message).toMatch(/only be sent on WhatsApp/i)
    expect(sendCardSetToConversation).not.toHaveBeenCalled()
  })

  it('unknown set name → error listing the available set names so the model self-corrects', async () => {
    const result = await executeCardTool('send_card_set', { set_name: 'Pricing deck' }, ctx())
    expect(result.error).toBe('not_found')
    expect(result.message).toContain('"Membership"')
    expect(result.message).toContain('"Studio tour"')
    expect(sendCardSetToConversation).not.toHaveBeenCalled()
  })

  it('no sets configured → explicit no-card-sets error', async () => {
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx({ db: makeDb({ sets: [] }) }))
    expect(result.error).toBe('not_found')
    expect(result.message).toMatch(/no card sets configured/i)
  })

  it('once-per-conversation guard: a prior carousel row blocks a second send', async () => {
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx({ db: makeDb({ carouselCount: 1 }) }))
    expect(result.error).toBe('already_sent')
    expect(result.message).toMatch(/already sent in this conversation/i)
    expect(sendCardSetToConversation).not.toHaveBeenCalled()
  })

  it('happy path: sends via the shared helper with source "agent" and returns sent', async () => {
    const db = makeDb()
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx({ db }))
    expect(result).toEqual({ sent: true, set: 'Membership' })
    expect(sendCardSetToConversation).toHaveBeenCalledTimes(1)
    expect(sendCardSetToConversation).toHaveBeenCalledWith(db, {
      set: SETS[0],
      conversation: { id: 'conv1', contact_id: 'ct1', wa_phone: '353871234567' },
      locationId: 'loc1',
      source: 'agent',
    })
  })

  it('matches set names case-insensitively and trimmed', async () => {
    const result = await executeCardTool('send_card_set', { set_name: '  studio TOUR  ' }, ctx())
    expect(result).toEqual({ sent: true, set: 'Studio tour' })
  })

  it('conversation without a wa_phone → no_recipient error, nothing sent', async () => {
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx({ db: makeDb({ conversation: { id: 'conv1', wa_phone: null } }) }))
    expect(result.error).toBe('no_recipient')
    expect(sendCardSetToConversation).not.toHaveBeenCalled()
  })

  it('a send failure is caught and returned as an error result (never throws)', async () => {
    sendCardSetToConversation.mockRejectedValueOnce(new Error('Meta 400: outside window'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await executeCardTool('send_card_set', { set_name: 'Membership' }, ctx())
    expect(result.error).toBe('send_failed')
    expect(result.message).toMatch(/answer in text/i)
    errSpy.mockRestore()
  })

  it('unknown tool name → unknown_tool (mirrors the other executors)', async () => {
    const result = await executeCardTool('send_stickers', {}, ctx())
    expect(result).toEqual({ error: 'unknown_tool', tool: 'send_stickers' })
  })
})
