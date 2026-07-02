import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the WhatsApp send BEFORE importing the module under test so
// maybeSendWelcomeGreeting never touches the network.
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.OUT1', status: 'sent' })),
}))

import { sendTextMessage } from '@/lib/whatsapp'
import {
  shouldSendWelcome,
  maybeSendWelcomeGreeting,
  DEFAULT_WELCOME_GREETING,
} from './welcome-greeting.js'

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
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, DEFAULT_WELCOME_GREETING, { locationId: 'loc1' })
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

  it('custom welcome_greeting is used when set', async () => {
    const db = fakeDb({ customerAgent: { enabled: true, welcome_greeting: '  Howdy from UN1T!  ' } })
    const r = await maybeSendWelcomeGreeting(db, CTX)
    expect(r).toEqual({ sent: true })
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, 'Howdy from UN1T!', { locationId: 'loc1' })
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
