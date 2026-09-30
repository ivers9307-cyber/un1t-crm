// WACONFIGFALLBACK.1 — the inbox actions on an existing thread (react, block,
// send a booking Flow, send a card set) at a location with no WhatsApp number
// of its own. Each used to act on the global env number (another studio's:
// the block even blocked the sender THERE). Now the resolver refuses and each
// route answers 409 with its message, writing nothing locally. Any other
// Meta failure keeps its 502. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccessOr404: vi.fn(() => null),
  requireWhatsAppInboxAnywhere: vi.fn(() => null),
  requireWhatsAppInboxAt: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendReaction: vi.fn(), setWhatsAppUserBlockState: vi.fn(), sendFlowMessage: vi.fn() }))
vi.mock('@/lib/whatsapp-carousel-send', () => ({ sendCardSetToConversation: vi.fn() }))

import { POST as react } from './react/route.js'
import { POST as block } from './block/route.js'
import { POST as sendFlow } from './send-flow/route.js'
import { POST as sendCarousel } from './send-carousel/route.js'
import { sendReaction, setWhatsAppUserBlockState, sendFlowMessage } from '@/lib/whatsapp'
import { sendCardSetToConversation } from '@/lib/whatsapp-carousel-send'
import { createServerClient } from '@/lib/supabase'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const SET_ID = 'c0000000-0000-4000-8000-000000000003'
const CONV = { id: 'conv-1', location_id: LOC, contact_id: 'contact-1', wa_phone: '+353000000000', is_blocked: false }
const SETTINGS = { whatsapp_flow: { flow_id: 'flow-1' }, wa_card_sets: [{ id: SET_ID, name: 'Intro', cards: [] }] }

let writes
function makeDb() {
  return {
    from: (table) => {
      const b = {
        select: () => b, eq: () => b,
        maybeSingle: async () => ({ data: CONV, error: null }),
        single: async () => ({ data: { settings: SETTINGS }, error: null }),
        insert: (row) => { writes.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
        update: (patch) => { writes.push({ table, op: 'update', patch }); return b },
        then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
      }
      return b
    },
  }
}

const json = (body) => new Request('https://crm.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: Promise.resolve({ id: 'conv-1' }) }

const ROUTES = [
  ['react', () => react(json({ message_id: 'wamid.1', emoji: '👍' }), props), sendReaction],
  ['block', () => block(json({ action: 'block' }), props), setWhatsAppUserBlockState],
  ['send-flow', () => sendFlow(new Request('https://crm.test/x', { method: 'POST' }), props), sendFlowMessage],
  ['send-carousel', () => sendCarousel(json({ card_set_id: SET_ID }), props), sendCardSetToConversation],
]

beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  createServerClient.mockReturnValue(makeDb())
})

describe.each(ROUTES)('%s', (_name, call, sender) => {
  it('no number at the conversation location → 409 with the resolver message, nothing written', async () => {
    sender.mockRejectedValue(new WhatsAppNumberMissingError(LOC))
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(writes).toEqual([])
  })

  it('any other Meta failure keeps its 502', async () => {
    sender.mockRejectedValue(new Error('(#131047) Re-engagement message'))
    const res = await call()
    expect(res.status).toBe(502)
  })
})
