import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the WhatsApp send BEFORE importing the module under test so
// maybeSendWelcomeGreeting never touches the network.
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.OUT1', status: 'sent' })),
}))
// W1.S3 — the code-default greeting is built from the location's resolved
// brand; the resolver is mocked so the fake db below sees only its two tables.
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'Gym A', shortName: 'Gym A', locationName: 'Gym A North' })),
}))

import { sendTextMessage } from '@/lib/whatsapp'
import { getLocationBranding } from '@/lib/location-branding'
import {
  shouldSendWelcome,
  maybeSendWelcomeGreeting,
  defaultWelcomeGreeting,
} from './welcome-greeting.js'

// What the code default renders for the mocked brand and an unset agent name
// (the contract's default name stands in, so the text matches the editor's).
const DEFAULT_WELCOME_GREETING = defaultWelcomeGreeting({ agentName: 'Mia', brand: 'Gym A' })

const PHONE = '353871234567'
// Fixed clock — 13:00 Dublin (summer), safely inside any all-day quiet window
// and outside a night-time one.
const NOON = new Date('2026-07-01T12:00:00Z')

describe('shouldSendWelcome', () => {
  it('disabled (no enabled, no test_mode) → no', () => {
    expect(shouldSendWelcome({ settings: { enabled: false, test_mode: false }, senderPhone: PHONE, now: NOON }))
      .toEqual({ send: false, reason: 'disabled' })
    // absent settings blob behaves as disabled too
    expect(shouldSendWelcome({ settings: null, senderPhone: PHONE, now: NOON }))
      .toEqual({ send: false, reason: 'disabled' })
  })

  it('test_mode + sender NOT in allowlist → no', () => {
    const settings = { enabled: false, test_mode: true, test_phones: ['+353879999999'] }
    expect(shouldSendWelcome({ settings, senderPhone: PHONE, now: NOON }))
      .toEqual({ send: false, reason: 'not_in_test_allowlist' })
  })

  it('test_mode + sender in allowlist → yes (last-9-digit match handles +353 vs 353)', () => {
    const settings = { enabled: false, test_mode: true, test_phones: ['+353871234567'] }
    expect(shouldSendWelcome({ settings, senderPhone: PHONE, now: NOON })).toEqual({ send: true })
  })

  it('enabled + quiet hours covering now → no', () => {
    const settings = {
      enabled: true,
      quiet_hours: { start: '00:00', end: '23:59', tz: 'Europe/Dublin' },
    }
    expect(shouldSendWelcome({ settings, senderPhone: PHONE, now: NOON }))
      .toEqual({ send: false, reason: 'quiet_hours' })
  })

  it('enabled, no quiet hours → yes', () => {
    expect(shouldSendWelcome({ settings: { enabled: true }, senderPhone: PHONE, now: NOON }))
      .toEqual({ send: true })
  })
})

// Chainable fake db covering the two whatsapp_messages shapes the module
// uses: the head-count select (awaited builder resolves { count }) and the
// insert. locations returns the settings blob.
function fakeDb({ customerAgent, outboundCount = 0 } = {}) {
  const inserted = []
  return {
    inserted,
    from(table) {
      if (table === 'locations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { settings: { customer_agent: customerAgent } } }),
            }),
          }),
        }
      }
      if (table === 'whatsapp_messages') {
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              then: (resolve) => resolve({ count: outboundCount }),
            }
            return builder
          },
          insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }) },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const CTX = { conversationId: 'conv1', locationId: 'loc1', senderPhone: PHONE, contactId: 'c1' }

describe('maybeSendWelcomeGreeting', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('enabled + no prior outbound → sends the default greeting and logs an agent-sourced row', async () => {
    const db = fakeDb({ customerAgent: { enabled: true } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: true })
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, DEFAULT_WELCOME_GREETING, { locationId: 'loc1', replyInConversation: 'conv1' })
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({
      conversation_id: 'conv1',
      contact_id: 'c1',
      location_id: 'loc1',
      wa_message_id: 'wamid.OUT1',
      direction: 'outbound',
      message_type: 'text',
      body: DEFAULT_WELCOME_GREETING,
      status: 'sent',
      source: 'agent',
    })
  })

  // HUMANIZE.1 — this is shipped customer copy on the click-to-WhatsApp path.
  it('the default greeting carries no dash and no emoji', () => {
    expect(DEFAULT_WELCOME_GREETING).not.toMatch(/[—–]/)
    expect(DEFAULT_WELCOME_GREETING).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  // W1.S3 — the default names the studio's brand and the configured agent.
  it('the default greeting carries the resolved brand and the agent_name, never a literal gym', async () => {
    const db = fakeDb({ customerAgent: { enabled: true, agent_name: 'Ava' } })
    await maybeSendWelcomeGreeting(db, CTX)
    expect(getLocationBranding).toHaveBeenCalledWith(db, 'loc1')
    const sent = sendTextMessage.mock.calls[0][1]
    expect(sent).toBe("Hi, I'm Ava, the studio's assistant at Gym A. Ask me anything, or tell me if you'd like to book a free class or a consultation.")
    expect(sent).not.toMatch(/UN1T/)
  })

  it('a blob saved without agent_name greets as the contract default name (what the editor shows)', async () => {
    const db = fakeDb({ customerAgent: { enabled: true } })
    await maybeSendWelcomeGreeting(db, CTX)
    expect(sendTextMessage.mock.calls[0][1]).toMatch(/^Hi, I'm Mia, the studio's assistant at Gym A\./)
  })

  it('an operator-set greeting never resolves the brand (no query spent on a text that is not sent)', async () => {
    const db = fakeDb({ customerAgent: { enabled: true, welcome_greeting: 'Hello there.' } })
    await maybeSendWelcomeGreeting(db, CTX)
    expect(getLocationBranding).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, 'Hello there.', { locationId: 'loc1', replyInConversation: 'conv1' })
  })

  it('with no agent name the greeting still reads naturally', () => {
    expect(defaultWelcomeGreeting({ brand: 'Gym A' })).toBe("Hi, I'm the studio's assistant at Gym A. Ask me anything, or tell me if you'd like to book a free class or a consultation.")
    expect(defaultWelcomeGreeting({ agentName: 'Mia' })).toBe("Hi, I'm Mia, the studio's assistant. Ask me anything, or tell me if you'd like to book a free class or a consultation.")
  })

  it('scrubs an em dash out of an operator-set greeting before sending', async () => {
    const db = fakeDb({ customerAgent: { enabled: true, welcome_greeting: "Hi — I'm Mia, ask away." } })
    await maybeSendWelcomeGreeting(db, CTX)
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, "Hi, I'm Mia, ask away.", { locationId: 'loc1', replyInConversation: 'conv1' })
    expect(db.inserted[0].body).toBe("Hi, I'm Mia, ask away.")
  })

  it('custom welcome_greeting is used when set', async () => {
    const db = fakeDb({ customerAgent: { enabled: true, welcome_greeting: '  Howdy from UN1T!  ' } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: true })
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, 'Howdy from UN1T!', { locationId: 'loc1', replyInConversation: 'conv1' })
    expect(db.inserted[0].body).toBe('Howdy from UN1T!')
  })

  it('prior outbound in the thread → skip already_greeted, nothing sent', async () => {
    const db = fakeDb({ customerAgent: { enabled: true }, outboundCount: 1 })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: false, reason: 'already_greeted' })
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(db.inserted).toHaveLength(0)
  })

  it('agent disabled → skip, sendTextMessage not called', async () => {
    const db = fakeDb({ customerAgent: { enabled: false, test_mode: false } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: false, reason: 'disabled' })
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(db.inserted).toHaveLength(0)
  })

  it('missing context → skip without touching the db', async () => {
    const r = await maybeSendWelcomeGreeting(fakeDb(), { ...CTX, conversationId: null })
    expect(r).toEqual({ sent: false, reason: 'missing_context' })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('send failure → best-effort { sent:false, reason:exception }, never throws', async () => {
    sendTextMessage.mockRejectedValueOnce(new Error('Meta down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb({ customerAgent: { enabled: true } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: false, reason: 'exception' })
    expect(db.inserted).toHaveLength(0)
    errSpy.mockRestore()
  })
})

// WACONFIGFALLBACK.1 — the greeting only fires for inbound, which only lands at
// a location that owns the receiving number, so a refusal here means the
// number was removed between receipt and reply. It used to go out on the
// global env number; now it is a quiet { sent:false }, nothing logged.
describe('maybeSendWelcomeGreeting — no WhatsApp number (WACONFIGFALLBACK.1)', () => {
  it('sent:false, never throws, nothing logged to the thread', async () => {
    const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')
    sendTextMessage.mockRejectedValueOnce(new WhatsAppNumberMissingError('loc1'))
    const db = fakeDb({ customerAgent: { enabled: true } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: false, reason: 'exception' })
    expect(db.inserted).toEqual([])
  })
})
