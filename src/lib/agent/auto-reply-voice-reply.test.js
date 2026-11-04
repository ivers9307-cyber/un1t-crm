// VOICEREPLY.1 — Mia answers a voice note by voice. Harness mirrors
// auto-reply-voice.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', async (importOriginal) => ({
  ...(await importOriginal()),
  sendTextMessage: vi.fn(),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => {}), sendPushToInboxStaffAtLocation: vi.fn(async () => {}) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({})) }))
vi.mock('@/lib/person-links', () => ({ personGroupResolver: vi.fn(async () => ({ groupOf: () => null, primaryOf: () => null })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./booking-tools', async (importOriginal) => ({ ...(await importOriginal()), executeBookingTool: vi.fn() }))

import { runChannelAgent, whatsappAdapter } from './auto-reply'
import { executeBookingTool } from './booking-tools'
import { logError } from '@/lib/log'

function agentDb({ conv, history, calls, settings, studios = [], earlierVoice = 0 }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null, cols: '' }
    const finish = () => {
      if (state.op === 'update') { calls.push({ table, op: 'update', patch: state.patch }); return { data: [{ id: 'conv-1' }], error: null } }
      if (table === 'locations') {
        if (state.sawIn) return { data: [{ id: 'loc-1', name: 'Stillorgan', active: true }], error: null }
        return { data: { name: 'Stillorgan', membership_source: 'glofox', settings: { customer_agent: settings } }, error: null }
      }
      if (table === 'contact_studios') return { data: studios, error: null }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: String(state.cols).includes('voice_kind') || state.sawNot ? earlierVoice : 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: history, error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { state.cols = cols || ''; if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
      eq: () => builder, or: () => builder, gte: () => builder, gt: () => { state.sawGt = true; return builder },
      not: () => { state.sawNot = true; return builder },
      is: () => builder, in: () => { state.sawIn = true; return builder }, order: () => builder, limit: () => builder, range: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { from: mk }
}

const okVoice = (o = {}) => vi.fn(async () => ({ sent: true, messageId: 'wamid.v', storagePath: 'loc-1/voice-reply-x.ogg', voiceKind: 'lead', chars: 10, buttonsLine: 'Tap an option:', aiNotice: null, ...o }))
function makeAdapter(sendVoice = okVoice()) {
  return {
    ...whatsappAdapter,
    trustsSenderIdentity: false, isHumanOutbound: undefined, onEngage: undefined,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.t' }),
    sendOptions: vi.fn().mockResolvedValue({ messageId: 'wamid.o' }),
    sendCta: vi.fn().mockResolvedValue({ messageId: 'wamid.c' }),
    sendVoice,
    voiceReplyPossible: vi.fn(async () => true),
  }
}
const now = () => new Date().toISOString()
const conv = { agent_active: true, contact_id: 'c-1', agent_verified_contact_id: 'c-1', agent_last_reply_at: null }
const voiceHistory = [{ direction: 'inbound', body: '', message_type: 'audio', created_at: now(), transcript_status: 'ok', transcript: 'Can I book 7am?' }]
const textHistory = [{ direction: 'inbound', body: 'Can I book 7am?', message_type: 'text', created_at: now() }]
const ctx = (messageType = 'audio') => ({
  conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', contactId: 'c-1', messageType, body: messageType === 'text' ? 'Can I book 7am?' : '', connection: null,
  ...(messageType === 'audio' ? { voiceTranscript: { status: 'ok', text: 'Can I book 7am?' } } : {}),
})
function modelTurns(...turns) {
  let i = 0
  return vi.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)] }))
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
const systemOf = (fetchSpy) => JSON.parse(fetchSpy.mock.calls[0][1].body).system
const inserts = (calls) => calls.filter((c) => c.op === 'insert' && c.table === 'whatsapp_messages').map((c) => c.row)

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); vi.unstubAllGlobals() })

describe('a typed message', () => {
  it('never voices and gets no spoken-reply line', async () => {
    const fetchSpy = modelTurns(say('Yes, 7am is free.'))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = makeAdapter()
    await runChannelAgent(agentDb({ conv, history: textHistory, calls: [], settings: { enabled: true } }), adapter, ctx('text'))
    expect(adapter.sendVoice).not.toHaveBeenCalled()
    expect(JSON.stringify(systemOf(fetchSpy))).not.toContain('This reply will be spoken')
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })
})

describe('a voice-note turn', () => {
  it('speaks the reply as a lead, records one audio row, sends no text', async () => {
    const fetchSpy = modelTurns(say('Yes, seven is free.'))
    vi.stubGlobal('fetch', fetchSpy)
    const calls = []
    const adapter = makeAdapter()
    const result = await runChannelAgent(agentDb({ conv, history: voiceHistory, calls, settings: { enabled: true } }), adapter, ctx())
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    const system = systemOf(fetchSpy)
    expect(JSON.stringify(system[0])).not.toContain('This reply will be spoken')   // the cached block is unchanged
    expect(JSON.stringify(system)).toContain('This reply will be spoken')
    expect(adapter.sendVoice).toHaveBeenCalledTimes(1)
    expect(adapter.sendVoice.mock.calls[0][1]).toMatchObject({ conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', spoken: 'Yes, seven is free.', kind: 'lead' })
    expect(adapter.send).not.toHaveBeenCalled()
    const rows = inserts(calls)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'outbound', message_type: 'audio', body: 'Yes, seven is free.', media_storage_path: 'loc-1/voice-reply-x.ogg', media_mime_type: 'audio/ogg', voice_kind: 'lead' })
  })

  it('a booking that went through picks the booking voice', async () => {
    executeBookingTool.mockResolvedValue({ booked: true, class_name: 'ENG1NE' })
    vi.stubGlobal('fetch', modelTurns(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'book_class', input: { event_id: '64aa00000000000000000001', class_name: 'ENG1NE' } }] },
      say('Booked you in for seven.'),
    ))
    const adapter = makeAdapter(okVoice({ voiceKind: 'booking' }))
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true } }), adapter, ctx())
    expect(adapter.sendVoice.mock.calls[0][1].kind).toBe('booking')
  })

  it('an active member at the studio picks the member voice', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Your plan renews on the first.')))
    const adapter = makeAdapter()
    const studios = [{ contact_id: 'c-1', location_id: 'loc-1', kind: 'member', status: 'active' }]
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true }, studios }), adapter, ctx())
    expect(adapter.sendVoice.mock.calls[0][1].kind).toBe('member')
  })

  it('a trailing link follows as the link button', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Great, book here https://x.test/b')))
    const calls = []
    const adapter = makeAdapter()
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls, settings: { enabled: true } }), adapter, ctx())
    expect(adapter.sendVoice.mock.calls[0][1].spoken).toBe('Great, book here')
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(adapter.send.mock.calls[0][1]).toBe('Great, book here https://x.test/b')
    expect(inserts(calls).map((r) => r.message_type)).toEqual(['audio', 'text'])
  })

  it('options follow as buttons under the buttons line', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Which time suits?\n[[OPTIONS]] 7am | 8am')))
    const adapter = makeAdapter(okVoice({ buttonsLine: 'Pick one:' }))
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true } }), adapter, ctx())
    expect(adapter.sendVoice.mock.calls[0][1].spoken).toBe('Which time suits?')
    expect(adapter.sendOptions).toHaveBeenCalledTimes(1)
    expect(adapter.sendOptions.mock.calls[0].slice(1, 3)).toEqual(['Pick one:', ['7am', '8am']])
  })

  it('the AI notice goes once, after the first voice reply only', async () => {
    vi.stubGlobal('fetch', modelTurns(say('See you at seven.')))
    const adapter = makeAdapter(okVoice({ aiNotice: 'Mia is an AI assistant.' }))
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true }, earlierVoice: 0 }), adapter, ctx())
    expect(adapter.send.mock.calls.map((c) => c[1])).toEqual(['Mia is an AI assistant.'])
    vi.stubGlobal('fetch', modelTurns(say('See you at seven.')))
    const adapter2 = makeAdapter(okVoice({ aiNotice: 'Mia is an AI assistant.' }))
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true }, earlierVoice: 1 }), adapter2, ctx())
    expect(adapter2.send).not.toHaveBeenCalled()
  })

  it('a refused voice sends exactly today\'s text', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Yes, seven is free.')))
    const calls = []
    const adapter = makeAdapter(vi.fn(async () => ({ sent: false, reason: 'capped' })))
    const result = await runChannelAgent(agentDb({ conv, history: voiceHistory, calls, settings: { enabled: true } }), adapter, ctx())
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send.mock.calls[0][1]).toBe('Yes, seven is free.')
    expect(inserts(calls)[0]).toMatchObject({ message_type: 'text', body: 'Yes, seven is free.' })
    const decision = calls.find((c) => c.op === 'insert' && c.table === 'agent_decisions')
    expect(decision.row.meta.voice).toEqual({ sent: false, reason: 'capped' })
  })

  it('voice sent but the follow-up failed: logged, not resent (Review Focus 3)', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Great, book here https://x.test/b')))
    const adapter = makeAdapter()
    adapter.send.mockRejectedValueOnce(new Error('meta down'))
    const result = await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true } }), adapter, ctx())
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('agent', expect.stringMatching(/follow-up/), expect.any(Object))
  })

  it('a text sent after the voice note is answered in text (Review Focus 1)', async () => {
    const fetchSpy = modelTurns(say('Yes.'))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = makeAdapter()
    // The mock returns history newest first, as the real descending read does.
    const history = [{ direction: 'inbound', body: 'also is there parking?', message_type: 'text', created_at: now() }, ...voiceHistory]
    await runChannelAgent(agentDb({ conv, history, calls: [], settings: { enabled: true } }), adapter, ctx())
    expect(adapter.sendVoice).not.toHaveBeenCalled()
    expect(JSON.stringify(systemOf(fetchSpy))).not.toContain('This reply will be spoken')
  })

  it('the holding message after an unclear voice note is spoken in the hand-off voice', async () => {
    vi.stubGlobal('fetch', modelTurns(say('never')))
    const calls = []
    const adapter = makeAdapter(okVoice({ voiceKind: 'handoff' }))
    const c = { ...ctx(), voiceTranscript: { status: 'unclear', text: 'mumble' } }
    const result = await runChannelAgent(agentDb({ conv, history: voiceHistory, calls, settings: { enabled: true } }), adapter, c)
    expect(result).toMatchObject({ action: 'handoff', reason: 'voice_unclear' })
    expect(adapter.sendVoice.mock.calls[0][1].kind).toBe('handoff')
    expect(adapter.send).not.toHaveBeenCalled()
    expect(inserts(calls)[0]).toMatchObject({ message_type: 'audio', voice_kind: 'handoff' })
  })

  it('a failed holding voice sends the holding text', async () => {
    vi.stubGlobal('fetch', modelTurns(say('never')))
    const adapter = makeAdapter(vi.fn(async () => ({ sent: false, reason: 'no_voice' })))
    const c = { ...ctx(), voiceTranscript: { status: 'too_long', text: null } }
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true } }), adapter, c)
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('follow-up rows are marked with the voice kind (review C1)', async () => {
    vi.stubGlobal('fetch', modelTurns(say('Great, book here https://x.test/b')))
    const calls = []
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls, settings: { enabled: true } }), makeAdapter(), ctx())
    expect(inserts(calls).map((r) => [r.message_type, r.voice_kind])).toEqual([['audio', 'lead'], ['text', 'lead']])
  })

  it('voice replies switched off: no spoken-reply line and no voice attempt (review I3)', async () => {
    const fetchSpy = modelTurns(say('Yes, seven is free.'))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = makeAdapter()
    adapter.voiceReplyPossible = vi.fn(async () => false)
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true } }), adapter, ctx())
    expect(JSON.stringify(systemOf(fetchSpy))).not.toContain('This reply will be spoken')
    expect(adapter.sendVoice).not.toHaveBeenCalled()
    expect(adapter.send.mock.calls[0][1]).toBe('Yes, seven is free.')
  })

  it('a link in the holding message follows as text (review I2)', async () => {
    vi.stubGlobal('fetch', modelTurns(say('never')))
    const adapter = makeAdapter(okVoice({ voiceKind: 'handoff' }))
    const c = { ...ctx(), voiceTranscript: { status: 'unclear', text: 'mumble' } }
    await runChannelAgent(agentDb({ conv, history: voiceHistory, calls: [], settings: { enabled: true, holding_message: 'Someone will reply soon, or book at https://x.test/b' } }), adapter, c)
    expect(adapter.sendVoice.mock.calls[0][1].spoken).toBe('Someone will reply soon, or book at')
    expect(adapter.send.mock.calls.map((x) => x[1])).toEqual(['Someone will reply soon, or book at https://x.test/b'])
  })

  it('Instagram has no voice', () => {
    expect(typeof whatsappAdapter.sendVoice).toBe('function')
  })
})
