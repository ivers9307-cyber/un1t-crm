import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { resendVoiceReplyAsText } from './reply-fallback.js'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'

const ROW = { id: 'm-1', message_type: 'audio', voice_kind: 'booking', body: 'Booked you in for seven.', conversation_id: 'conv-1', location_id: 'loc-1', contact_id: 'c-1', voice_fallback_sent_at: null }

function makeDb({ claimRows = [{ id: 'm-1' }], claimError = null, phone = '353871234567', insertError = null } = {}) {
  const calls = []
  return {
    calls,
    from: vi.fn((table) => {
      const state = {}
      const b = {
        update: (patch) => { state.patch = patch; return b },
        insert: async (row) => { calls.push({ table, insert: row }); return { error: insertError } },
        select: () => b, eq: () => b,
        is: (c, v) => { state.is = [c, v]; return b },
        maybeSingle: async () => ({ data: table === 'whatsapp_conversations' ? (phone ? { wa_phone: phone } : null) : null, error: null }),
        then: (res, rej) => {
          if (table === 'whatsapp_messages' && state.patch) {
            calls.push({ table, claim: state.patch, is: state.is })
            return Promise.resolve(claimError ? { data: null, error: claimError } : { data: claimRows, error: null }).then(res, rej)
          }
          return Promise.resolve({ data: null, error: null }).then(res, rej)
        },
      }
      return b
    }),
  }
}
const deps = (o = {}) => ({ sendText: vi.fn(async () => ({ messageId: 'wamid.t' })), push: vi.fn(async () => {}), ...o })

beforeEach(() => vi.clearAllMocks())

describe('resendVoiceReplyAsText', () => {
  test('claims once, sends the stored text, records it', async () => {
    const db = makeDb()
    const d = deps()
    expect(await resendVoiceReplyAsText(db, ROW, d)).toEqual({ resent: true })
    const claim = db.calls.find((c) => c.claim)
    expect(Object.keys(claim.claim)).toEqual(['voice_fallback_sent_at'])
    expect(claim.is).toEqual(['voice_fallback_sent_at', null])
    expect(d.sendText).toHaveBeenCalledWith('353871234567', 'Booked you in for seven.', { locationId: 'loc-1', replyInConversation: 'conv-1' })
    expect(db.calls.find((c) => c.insert).insert).toMatchObject({ conversation_id: 'conv-1', direction: 'outbound', message_type: 'text', body: 'Booked you in for seven.', source: 'agent', wa_message_id: 'wamid.t' })
    expect(d.push).not.toHaveBeenCalled()
  })
  test('a second failed webhook sends nothing (Review Focus 4)', async () => {
    const d = deps()
    expect(await resendVoiceReplyAsText(makeDb({ claimRows: [] }), ROW, d)).toEqual({ resent: false, reason: 'already_sent' })
    expect(d.sendText).not.toHaveBeenCalled()
  })
  test('not a voice reply, or nothing to send', async () => {
    const d = deps()
    expect((await resendVoiceReplyAsText(makeDb(), { ...ROW, voice_kind: null }, d)).reason).toBe('not_a_voice_reply')
    expect((await resendVoiceReplyAsText(makeDb(), { ...ROW, body: '  ' }, d)).reason).toBe('not_a_voice_reply')
    // A failed follow-up text row also carries voice_kind (review C1): it is not the voice note.
    expect((await resendVoiceReplyAsText(makeDb(), { ...ROW, message_type: 'text' }, d)).reason).toBe('not_a_voice_reply')
    expect(d.sendText).not.toHaveBeenCalled()
  })
  test('no number switched on: recorded skip and a staff push', async () => {
    const d = deps({ sendText: vi.fn(async () => { throw new WhatsAppNumberMissingError('loc-1') }) })
    expect(await resendVoiceReplyAsText(makeDb(), ROW, d)).toEqual({ resent: false, reason: 'no_number' })
    expect(d.push).toHaveBeenCalledTimes(1)
    expect(d.push.mock.calls[0][1]).toMatchObject({ title: 'WhatsApp · voice reply not delivered' })
  })
  test('a send error or a missing phone also pushes staff', async () => {
    const d = deps({ sendText: vi.fn(async () => { throw new Error('meta down') }) })
    expect((await resendVoiceReplyAsText(makeDb(), ROW, d)).reason).toBe('send_failed')
    const d2 = deps()
    expect((await resendVoiceReplyAsText(makeDb({ phone: null }), ROW, d2)).reason).toBe('no_phone')
    expect(d.push).toHaveBeenCalledTimes(1)
    expect(d2.push).toHaveBeenCalledTimes(1)
  })
  test('a failed claim never sends; nothing throws', async () => {
    const d = deps()
    expect((await resendVoiceReplyAsText(makeDb({ claimError: { message: 'x' } }), ROW, d)).reason).toBe('claim_failed')
    expect(d.sendText).not.toHaveBeenCalled()
    await expect(resendVoiceReplyAsText({ from: () => { throw new Error('db') } }, ROW, d)).resolves.toMatchObject({ resent: false })
  })
})
