// WAREPLYNUMBER.1 (C86) — Mia replies from the number the customer wrote to.
//
// The WhatsApp adapter's sends (reply, tap choices, holding message, typing
// indicator) name the conversation, so the sender resolves the number the
// webhook recorded on it (else the studio default). sendAndLog, the handoff
// and the soft handoff hand the adapter the conversation id. Instagram's
// adapter ignores the extra key.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', async (importOriginal) => ({
  ...(await importOriginal()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.T' })),
  sendInteractiveOptions: vi.fn(async () => ({ messageId: 'wamid.O' })),
  sendCtaUrlMessage: vi.fn(async () => ({ messageId: 'wamid.C' })),
  sendTypingIndicator: vi.fn(async () => ({})),
}))

import { sendAndLog, whatsappAdapter } from './auto-reply'
import { sendTextMessage, sendInteractiveOptions, sendCtaUrlMessage, sendTypingIndicator } from '@/lib/whatsapp'

const CONV = 'conv-1'
const LOC = 'loc-1'

function stubDb() {
  return {
    from() {
      return {
        insert: async () => ({}),
        update: () => ({ eq: async () => ({}) }),
      }
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('whatsappAdapter — the reply number', () => {
  it('a reply, a link reply, tap choices and the typing indicator all name the conversation', async () => {
    await whatsappAdapter.send('353870000000', 'See you at 7', { locationId: LOC, conversationId: CONV })
    await whatsappAdapter.send('353870000000', 'Book here: https://x.test/e', { locationId: LOC, conversationId: CONV })
    await whatsappAdapter.sendOptions('353870000000', 'Pick', ['7am', '8am'], { locationId: LOC, conversationId: CONV })
    await whatsappAdapter.onEngage({ waMessageId: 'wamid.IN', locationId: LOC, conversationId: CONV })
    const want = { locationId: LOC, replyInConversation: CONV }
    expect(sendTextMessage.mock.calls[0][2]).toEqual(want)
    expect(sendCtaUrlMessage.mock.calls[0][2]).toEqual(want)
    expect(sendInteractiveOptions.mock.calls[0][3]).toEqual(want)
    expect(sendTypingIndicator.mock.calls[0][1]).toEqual(want)
  })

  it('the link reply’s plain-text fallback names it too', async () => {
    sendCtaUrlMessage.mockRejectedValueOnce(new Error('cta_url not supported'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await whatsappAdapter.send('353870000000', 'Book here: https://x.test/e', { locationId: LOC, conversationId: CONV })
    warn.mockRestore()
    expect(sendTextMessage.mock.calls[0][2]).toEqual({ locationId: LOC, replyInConversation: CONV })
  })
})

describe('sendAndLog hands the adapter the conversation', () => {
  const base = { conversationId: CONV, locationId: LOC, recipient: '353870000000', contactId: 'c1', connection: null }

  it('a reply', async () => {
    const send = vi.fn(async () => ({ messageId: 'wamid.1' }))
    await sendAndLog(stubDb(), { ...whatsappAdapter, send }, { ...base, text: 'Hi' })
    expect(send.mock.calls[0][2]).toMatchObject({ locationId: LOC, conversationId: CONV })
  })

  it('tap choices', async () => {
    const sendOptions = vi.fn(async () => ({ messageId: 'wamid.2' }))
    await sendAndLog(stubDb(), { ...whatsappAdapter, sendOptions }, { ...base, text: 'Pick', options: ['a', 'b'] })
    expect(sendOptions.mock.calls[0][3]).toMatchObject({ locationId: LOC, conversationId: CONV })
  })
})
