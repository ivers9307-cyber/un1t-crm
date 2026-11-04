import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/usage', () => ({ recordMeterUsage: vi.fn(async () => {}) }))

import { logWarn } from '@/lib/log'
import { recordMeterUsage } from '@/lib/usage'
import { maybeSendVoiceReply, voiceReplyPossible } from './reply.js'

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3])
const VOICES = { booking: { voice_id: 'vb', name: 'Bea' }, default: { voice_id: 'vd', name: 'Dan' } }

function makeDb({ mode = 'on', testPhones = [], settingsError = null, voices = VOICES, locError = null, uploadError = null, extra = {} } = {}) {
  const uploads = []
  return {
    uploads,
    from: vi.fn((table) => {
      if (table === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: locError ? null : { organization_id: 'org-1', settings: { voice_replies: { voices, ...extra } } }, error: locError }) }) }) }
      if (table === 'org_settings') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settingsError ? null : { voice_reply_mode: mode, voice_reply_test_phones: testPhones }, error: settingsError }) }) }) }
      throw new Error(`unexpected ${table}`)
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async (path, bytes, opts) => { uploads.push({ path, opts }); return uploadError ? { error: uploadError } : { data: { path }, error: null } }),
        createSignedUrl: vi.fn(async (path, ttl) => ({ data: { signedUrl: `https://store.test/${path}?ttl=${ttl}` }, error: null })),
      })),
    },
  }
}

const args = (o = {}) => ({ conversationId: 'conv-1', locationId: 'loc-1', recipient: '353871234567', spoken: 'Your class is booked for seven.', kind: 'booking', replyOpts: { locationId: 'loc-1', conversationId: 'conv-1' }, ...o })
const deps = (o = {}) => ({
  synthesize: vi.fn(async () => ({ ok: true, bytes: OGG, mime: 'audio/ogg' })),
  capStatus: vi.fn(async () => ({ capped: false })),
  sendMedia: vi.fn(async () => ({ messageId: 'wamid.v1' })),
  ...o,
})

beforeEach(() => { vi.mocked(logWarn).mockClear(); vi.mocked(recordMeterUsage).mockClear() })

describe('maybeSendVoiceReply gates', () => {
  const refused = async (db, a, d, reason) => {
    const r = await maybeSendVoiceReply(db, a, d)
    expect(r).toEqual({ sent: false, reason })
    expect(d.sendMedia).not.toHaveBeenCalled()
  }
  test('mode off', () => refused(makeDb({ mode: 'off' }), args(), deps(), 'disabled'))
  test('test mode, number not listed', () => refused(makeDb({ mode: 'test', testPhones: ['+353 87 000 0000'] }), args(), deps(), 'not_in_test_list'))
  test('settings unreadable', () => refused(makeDb({ settingsError: { message: 'x' } }), args(), deps(), 'settings_unreadable'))
  test('studio unreadable', () => refused(makeDb({ locError: { message: 'x' } }), args(), deps(), 'settings_unreadable'))
  test('cap reached', () => refused(makeDb(), args(), deps({ capStatus: vi.fn(async () => ({ capped: true })) }), 'capped'))
  test('no voice for the kind or default', () => refused(makeDb({ voices: {} }), args(), deps(), 'no_voice'))
  test('over 600 characters', () => refused(makeDb(), args({ spoken: 'a'.repeat(601) }), deps(), 'too_long'))
  test('nothing to speak', () => refused(makeDb(), args({ spoken: '   ' }), deps(), 'nothing_to_speak'))
  test('each speech failure passes through', async () => {
    for (const reason of ['not_configured', 'http_error', 'timeout', 'bad_response']) {
      await refused(makeDb(), args(), deps({ synthesize: vi.fn(async () => ({ ok: false, reason })) }), reason)
    }
  })
  test('audio that is not Ogg', () => refused(makeDb(), args(), deps({ synthesize: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([0xff, 0xfb, 0]), mime: 'audio/ogg' })) }), 'not_ogg'))
  test('upload failed', () => refused(makeDb({ uploadError: { message: 'x' } }), args(), deps(), 'upload_failed'))
  test('send threw', async () => {
    const d = deps({ sendMedia: vi.fn(async () => { throw new Error('meta down') }) })
    expect(await maybeSendVoiceReply(makeDb(), args(), d)).toEqual({ sent: false, reason: 'send_failed' })
  })
  test('the spoken text is never logged', async () => {
    await maybeSendVoiceReply(makeDb({ mode: 'off' }), args({ spoken: 'secret words here' }), deps())
    await maybeSendVoiceReply(makeDb(), args({ spoken: 'secret words here' }), deps({ synthesize: vi.fn(async () => ({ ok: false, reason: 'http_error' })) }))
    expect(vi.mocked(logWarn).mock.calls.length).toBeGreaterThan(0)
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain('secret words')
  })
})

describe('maybeSendVoiceReply success', () => {
  test('sends a voice note once, stores it, meters it', async () => {
    const db = makeDb({ extra: { buttons_line: 'Pick one:', ai_notice: '  Mia is an AI assistant.  ' } })
    const d = deps()
    const r = await maybeSendVoiceReply(db, args(), d)
    expect(r).toMatchObject({ sent: true, messageId: 'wamid.v1', voiceKind: 'booking', chars: 31, buttonsLine: 'Pick one:', aiNotice: 'Mia is an AI assistant.' })
    expect(r.storagePath).toMatch(/^loc-1\/voice-reply-[0-9a-f-]+\.ogg$/)
    expect(db.uploads[0].opts).toMatchObject({ contentType: 'audio/ogg' })
    expect(d.synthesize).toHaveBeenCalledWith({ text: 'Your class is booked for seven.', voiceId: 'vb' })
    expect(d.sendMedia).toHaveBeenCalledTimes(1)
    const [to, type, url, caption, opts] = d.sendMedia.mock.calls[0]
    expect([to, type, caption]).toEqual(['353871234567', 'audio', null])
    expect(url).toContain('ttl=3600')
    expect(opts).toEqual({ locationId: 'loc-1', conversationId: 'conv-1', voice: true })
    const meters = vi.mocked(recordMeterUsage).mock.calls.map(([e]) => [e.meter, e.quantity])
    expect(meters).toEqual([['elevenlabs_tts_characters', 31], ['elevenlabs_tts_replies', 1]])
  })
  test('a missing kind uses the default voice; the defaults for buttons and notice', async () => {
    const r = await maybeSendVoiceReply(makeDb(), args({ kind: 'member' }), deps())
    expect(r).toMatchObject({ sent: true, voiceKind: 'default', buttonsLine: 'Tap an option:', aiNotice: null })
  })
  test('test mode with the number listed sends', async () => {
    const r = await maybeSendVoiceReply(makeDb({ mode: 'test', testPhones: ['+353 87 123 4567'] }), args(), deps())
    expect(r.sent).toBe(true)
  })
  test('a metering failure still counts as sent', async () => {
    vi.mocked(recordMeterUsage).mockRejectedValueOnce(new Error('x'))
    expect((await maybeSendVoiceReply(makeDb(), args(), deps())).sent).toBe(true)
  })
  test('two replies racing at the cap may both voice, never throwing (Review Focus 5)', async () => {
    const d = deps()
    const [a, b] = await Promise.all([maybeSendVoiceReply(makeDb(), args(), d), maybeSendVoiceReply(makeDb(), args(), d)])
    expect(a.sent && b.sent).toBe(true)
  })
  test('never throws when everything throws', async () => {
    const db = { from: () => { throw new Error('db') }, storage: { from: () => { throw new Error('s') } } }
    expect((await maybeSendVoiceReply(db, args(), deps())).sent).toBe(false)
  })
})

describe('voiceReplyPossible (review I3: no spoken-reply prompt unless voice can go)', () => {
  test('on with a voice, or test with the number listed', async () => {
    expect(await voiceReplyPossible(makeDb(), { locationId: 'loc-1', recipient: '353871234567' })).toBe(true)
    expect(await voiceReplyPossible(makeDb({ mode: 'test', testPhones: ['+353 87 123 4567'] }), { locationId: 'loc-1', recipient: '353871234567' })).toBe(true)
  })
  test('off, test without the number, no voice at all, or unreadable settings', async () => {
    const r = { locationId: 'loc-1', recipient: '353871234567' }
    expect(await voiceReplyPossible(makeDb({ mode: 'off' }), r)).toBe(false)
    expect(await voiceReplyPossible(makeDb({ mode: 'test', testPhones: [] }), r)).toBe(false)
    expect(await voiceReplyPossible(makeDb({ voices: {} }), r)).toBe(false)
    expect(await voiceReplyPossible(makeDb({ settingsError: { message: 'x' } }), r)).toBe(false)
    expect(await voiceReplyPossible({ from: () => { throw new Error('db') } }, r)).toBe(false)
  })
})
