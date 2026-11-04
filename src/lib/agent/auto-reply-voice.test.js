// VOICENOTE.1 — Mia and a transcribed WhatsApp voice note. Harness mirrors
// auto-reply-no-credits.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  getOrCreateConversation: vi.fn(),
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn(async () => {}),
  sendPushToInboxStaffAtLocation: vi.fn(async () => {}),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({})),
}))
vi.mock('@/lib/person-links', () => ({
  personGroupResolver: vi.fn(async () => ({ groupOf: () => null, primaryOf: () => null })),
}))

import { runChannelAgent, whatsappAdapter, markVoiceNoteForStaff, VOICE_HANDOFF_REASON } from './auto-reply'
import { instagramAdapter } from './instagram'
import { sendPushToRolesAtLocation } from '@/lib/push'

function agentDb({ conv, history, calls, settings, selects = [], claimHeld = false }) {
  const mk = (table) => {
    const state = { op: 'select', patch: null, selectOpts: null }
    const finish = () => {
      if (state.op === 'update') {
        calls.push({ table, op: 'update', patch: state.patch })
        // Another turn holds the agent_processing_at claim: the claim matches no row.
        if (claimHeld && state.patch?.agent_processing_at) return { data: [], error: null }
        return { data: [{ id: 'conv-1' }], error: null }
      }
      if (table === 'locations') return { data: { name: 'Stillorgan', membership_source: 'glofox', settings: { customer_agent: settings } }, error: null }
      if (table === 'whatsapp_conversations') return { data: conv, error: null }
      if (table === 'whatsapp_messages') {
        if (state.selectOpts?.head) return { count: 0, error: null }
        if (state.sawGt) return { data: [], error: null }
        return { data: history, error: null }
      }
      return { data: [], error: null }
    }
    const builder = {
      select: (cols, opts) => { selects.push({ table, cols }); if (opts) state.selectOpts = opts; return builder },
      update: (patch) => { state.op = 'update'; state.patch = patch; return builder },
      insert: (row) => { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
      eq: () => builder, or: () => builder, gte: () => builder,
      gt: () => { state.sawGt = true; return builder },
      is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
      single: () => builder, maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return builder
  }
  return { from: mk }
}

function makeAdapter() {
  return {
    ...whatsappAdapter,
    trustsSenderIdentity: false,
    isHumanOutbound: undefined,
    onEngage: undefined,
    // VOICEREPLY.1 voice replies are tested in auto-reply-voice-reply.test.js;
    // these tests are about transcription, so replies stay text here.
    sendVoice: undefined,
    send: vi.fn().mockResolvedValue({ messageId: 'wamid.x' }),
  }
}

const now = () => new Date().toISOString()
const audioCtx = (voiceTranscript) => ({
  conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', contactId: 'c-1',
  messageType: 'audio', body: '', connection: null, ...(voiceTranscript !== undefined ? { voiceTranscript } : {}),
})
const conv = { agent_active: true, contact_id: 'c-1', agent_verified_contact_id: 'c-1', agent_last_reply_at: null }
const audioRow = (status, transcript) => ({ direction: 'inbound', body: '', message_type: 'audio', created_at: now(), transcript_status: status, transcript })

function modelReplies(text) {
  return vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
  }))
}

let errSpy, warnSpy
beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore(); warnSpy.mockRestore()
  vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('an ok voice note', () => {
  it('is answered like the text it says, from the stored transcript', async () => {
    const fetchSpy = modelReplies('Yes, the 7am has space.')
    vi.stubGlobal('fetch', fetchSpy)
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv, history: [audioRow('ok', 'Can I book 7am?')], calls, settings: { enabled: true } })
    const result = await runChannelAgent(db, adapter, audioCtx({ status: 'ok', text: 'Can I book 7am?' }))
    expect(result).toMatchObject({ handled: true, action: 'reply' })
    expect(fetchSpy).toHaveBeenCalled()
    const sentToModel = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(JSON.stringify(sentToModel.messages)).toContain('(voice note transcript) Can I book 7am?')
    expect(adapter.send.mock.calls[0][1]).toBe('Yes, the 7am has space.')
  })
})

describe('a voice note Mia cannot answer', () => {
  const cases = [
    ['unclear', 'voice_unclear', "Voice note Mia couldn't make out"],
    ['too_long', 'voice_too_long', 'Voice note over 3 minutes'],
    ['capped', 'voice_unavailable', 'Voice note: transcription unavailable'],
    ['failed', 'voice_unavailable', 'Voice note: transcription unavailable'],
    ['not_configured', 'voice_unavailable', 'Voice note: transcription unavailable'],
  ]
  for (const [status, reason, pushText] of cases) {
    it(`${status} → a real hand-off (${reason})`, async () => {
      const fetchSpy = modelReplies('never')
      vi.stubGlobal('fetch', fetchSpy)
      const calls = []
      const adapter = makeAdapter()
      const db = agentDb({ conv, history: [audioRow(status, 'x')], calls, settings: { enabled: true } })
      const result = await runChannelAgent(db, adapter, audioCtx({ status, text: status === 'unclear' ? 'mumble' : null }))
      expect(result).toMatchObject({ handled: true, action: 'handoff', reason })
      const patch = calls.find((c) => c.op === 'update' && c.patch?.agent_handed_off_at)
      expect(patch.patch).toMatchObject({ agent_active: false, handoff_escalated_at: null })
      expect(adapter.send).toHaveBeenCalledTimes(1) // the holding message
      expect(fetchSpy).not.toHaveBeenCalled()
      const push = vi.mocked(sendPushToRolesAtLocation).mock.calls.at(-1)[2]
      expect(push.body).toContain(pushText)
    })
  }
  it('runs under the turn claim and releases it (review I-2)', async () => {
    vi.stubGlobal('fetch', modelReplies('never'))
    const calls = []
    const db = agentDb({ conv, history: [audioRow('unclear', 'x')], calls, settings: { enabled: true } })
    await runChannelAgent(db, makeAdapter(), audioCtx({ status: 'unclear', text: 'mumble' }))
    const claimAt = calls.findIndex((c) => c.op === 'update' && c.patch?.agent_processing_at)
    const handoffAt = calls.findIndex((c) => c.op === 'update' && c.patch?.agent_active === false)
    const releaseAt = calls.findIndex((c) => c.op === 'update' && c.patch && 'agent_processing_at' in c.patch && c.patch.agent_processing_at === null)
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(handoffAt).toBeGreaterThan(claimAt)
    expect(releaseAt).toBeGreaterThan(handoffAt)
  })

  it('while another turn holds the claim: no hand-off, no holding message, in_flight (review I-2)', async () => {
    vi.stubGlobal('fetch', modelReplies('never'))
    const calls = []
    const adapter = makeAdapter()
    const db = agentDb({ conv, history: [audioRow('unclear', 'x')], calls, settings: { enabled: true }, claimHeld: true })
    const result = await runChannelAgent(db, adapter, audioCtx({ status: 'unclear', text: 'mumble' }))
    expect(result).toMatchObject({ handled: false, reason: 'in_flight' })
    expect(calls.find((c) => c.op === 'update' && c.patch?.agent_active === false)).toBeUndefined()
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('every non-ok status but disabled maps to a reason', () => {
    expect(VOICE_HANDOFF_REASON).toEqual({ unclear: 'voice_unclear', too_long: 'voice_too_long', capped: 'voice_unavailable', failed: 'voice_unavailable', not_configured: 'voice_unavailable' })
  })
})

describe('switched off, or no transcription', () => {
  for (const vt of [{ status: 'disabled', text: null }, undefined]) {
    it(`keeps today's soft hand-off (${vt ? vt.status : 'no voiceTranscript'})`, async () => {
      vi.stubGlobal('fetch', modelReplies('never'))
      const calls = []
      const adapter = makeAdapter()
      const db = agentDb({ conv, history: [audioRow(vt ? 'disabled' : null, null)], calls, settings: { enabled: true } })
      const result = await runChannelAgent(db, adapter, audioCtx(vt))
      expect(result).toMatchObject({ handled: true, action: 'soft_handoff', reason: 'unsupported_type' })
      expect(calls.find((c) => c.op === 'update' && c.patch?.agent_active === false)).toBeUndefined()
    })
  }
})

describe('Mia off duty', () => {
  it('disabled: no hand-off', async () => {
    vi.stubGlobal('fetch', modelReplies('never'))
    const adapter = makeAdapter()
    const db = agentDb({ conv, history: [audioRow('unclear', 'x')], calls: [], settings: { enabled: false } })
    expect(await runChannelAgent(db, adapter, audioCtx({ status: 'unclear', text: 'x' }))).toMatchObject({ handled: false, reason: 'disabled' })
    expect(adapter.send).not.toHaveBeenCalled()
  })
  it('quiet hours: no hand-off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
    vi.stubGlobal('fetch', modelReplies('never'))
    const adapter = makeAdapter()
    const db = agentDb({ conv, history: [audioRow('unclear', 'x')], calls: [], settings: { enabled: true, quiet_hours: { start: '11:00', end: '13:00', tz: 'UTC' } } })
    expect(await runChannelAgent(db, adapter, audioCtx({ status: 'unclear', text: 'x' }))).toMatchObject({ handled: false, reason: 'quiet_hours' })
    expect(adapter.send).not.toHaveBeenCalled()
  })
})

describe('history columns per channel', () => {
  it('WhatsApp reads the transcript; Instagram never names it', async () => {
    expect(whatsappAdapter.historyColumns).toBe('direction, body, message_type, created_at, source, transcript, transcript_status, voice_kind')
    expect(instagramAdapter.historyColumns).toBe('direction, body, message_type, created_at, source')
    vi.stubGlobal('fetch', modelReplies('ok'))
    const selects = []
    const db = agentDb({ conv, history: [audioRow('ok', 'Can I book 7am?')], calls: [], settings: { enabled: true }, selects })
    await runChannelAgent(db, makeAdapter(), audioCtx({ status: 'ok', text: 'Can I book 7am?' }))
    const historySelects = selects.filter((s) => s.table === 'whatsapp_messages' && /direction/.test(s.cols || ''))
    expect(historySelects.length).toBeGreaterThan(0)
    for (const s of historySelects) expect(s.cols).toBe(whatsappAdapter.historyColumns)
  })
})

describe('markVoiceNoteForStaff', () => {
  it('stamps the hand-off queue without switching Mia off, and pushes once', async () => {
    const calls = []
    const db = agentDb({ conv, history: [], calls, settings: {} })
    await markVoiceNoteForStaff(db, { conversationId: 'conv-1', locationId: 'loc-1' })
    const upd = calls.filter((c) => c.op === 'update')
    expect(upd).toHaveLength(1)
    expect(upd[0].table).toBe('whatsapp_conversations')
    expect(upd[0].patch).not.toHaveProperty('agent_active')
    expect(typeof upd[0].patch.agent_handed_off_at).toBe('string')
    expect(upd[0].patch.handoff_escalated_at).toBeNull()
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const push = vi.mocked(sendPushToRolesAtLocation).mock.calls[0][2]
    expect(push.title).toBe('WhatsApp · voice note needs a look')
    expect(push.body).toBe('A voice note arrived while Mia was answering another message — check it was covered.')
  })
  it('never throws', async () => {
    vi.mocked(sendPushToRolesAtLocation).mockRejectedValueOnce(new Error('push down'))
    const db = { from: () => { throw new Error('db down') } }
    await expect(markVoiceNoteForStaff(db, { conversationId: 'conv-1', locationId: 'loc-1' })).resolves.toBeUndefined()
  })
})
