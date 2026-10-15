// WASTUDIOPICK.1 — the resolver orchestrator. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('./config', () => ({ readPickerConfig: vi.fn(), PICKER_ID_PREFIX: 'studio:' }))
vi.mock('./signals', () => ({ adSignal: vi.fn(), replySignal: vi.fn(), tapSignal: vi.fn() }))
vi.mock('./classify', () => ({ classifyStudio: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendInteractiveOptions: vi.fn() }))
vi.mock('@/lib/agent/core', () => ({ AGENT_MESSAGE_SOURCE: 'agent', stripEmDashes: (s) => s }))
vi.mock('../log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
import { readPickerConfig } from './config'
import { adSignal, replySignal, tapSignal } from './signals'
import { classifyStudio } from './classify'
import { sendInteractiveOptions } from '@/lib/whatsapp'
import { resolveNewSenderStudio } from './resolve.js'

const CFG = { enabled: true, question: 'Which studio?', studios: [{ id: 'a1', label: 'Stillorgan' }, { id: 'a2', label: 'Hatch Street' }] }
const base = { conversationId: 'c1', threadLocationId: 'a1', receivingLocationId: 'a1', contactId: null, resolution: null, messageType: 'text', body: 'hi', senderPhone: '353000000000', message: { type: 'text', text: { body: 'hi' } } }

let updates
let inserts
let db
const recorded = () => updates[updates.length - 1]
const messageInsert = () => inserts[inserts.length - 1]

beforeEach(() => {
  vi.resetAllMocks()
  updates = []
  inserts = []
  db = {
    rpc: vi.fn(),
    from: vi.fn((table) => {
      if (table === 'whatsapp_conversations') {
        return { update: vi.fn((patch) => ({ eq: vi.fn(async () => { updates.push(patch.studio_resolution); return { error: null } }) })) }
      }
      if (table === 'whatsapp_messages') {
        return { insert: vi.fn(async (row) => { inserts.push(row); return { error: null } }) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  readPickerConfig.mockResolvedValue(CFG)
  adSignal.mockResolvedValue(null)
  replySignal.mockResolvedValue(null)
  tapSignal.mockReturnValue(null)
  classifyStudio.mockResolvedValue({ studioId: null, reason: 'unsure' })
})

describe('resolveNewSenderStudio', () => {
  it('skips a known contact, a thread at another studio, a final resolution, picker off, one listed studio', async () => {
    for (const ctx of [{ contactId: 'k1' }, { threadLocationId: 'a2' }, { resolution: { status: 'decided' } }, { resolution: { status: 'unresolved' } }]) {
      expect((await resolveNewSenderStudio(db, { ...base, ...ctx })).action).toBe('skip')
    }
    readPickerConfig.mockResolvedValueOnce({ ...CFG, enabled: false })
    expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
    readPickerConfig.mockResolvedValueOnce({ ...CFG, studios: [CFG.studios[0]] })
    expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
    readPickerConfig.mockResolvedValueOnce(null)
    expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
  })

  it('ad decides first: moves to Hatch and records by:ad, no classifier, no picker', async () => {
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    const r = await resolveNewSenderStudio(db, { ...base, message: { ...base.message, referral: { source_type: 'ad', source_id: 'AD1' } } })
    expect(r).toEqual({ action: 'decided', locationId: 'a2', conversationId: 'c1' })
    expect(db.rpc).toHaveBeenCalledWith('move_whatsapp_conversation', { p_conversation_id: 'c1', p_target_location_id: 'a2' })
    expect(recorded()).toMatchObject({ status: 'decided', by: 'ad', location_id: 'a2' })
    expect(classifyStudio).not.toHaveBeenCalled()
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
  })

  it('a decision for the thread’s own studio records but does not move', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: 'a1', reason: 'decided' })
    const r = await resolveNewSenderStudio(db, base)
    expect(r).toEqual({ action: 'decided', locationId: 'a1', conversationId: 'c1' })
    expect(db.rpc).not.toHaveBeenCalled()
    expect(recorded()).toMatchObject({ status: 'decided', by: 'ai', location_id: 'a1' })
  })

  it('nothing decides → picker sent through the thread, logged, recorded asked', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    const r = await resolveNewSenderStudio(db, base)
    expect(r.action).toBe('asked')
    expect(sendInteractiveOptions).toHaveBeenCalledWith('353000000000', 'Which studio?',
      [{ id: 'studio:a1', title: 'Stillorgan' }, { id: 'studio:a2', title: 'Hatch Street' }],
      { locationId: 'a1', replyInConversation: 'c1' })
    expect(messageInsert()).toMatchObject({ conversation_id: 'c1', direction: 'outbound', message_type: 'interactive', body: 'Which studio?', wa_message_id: 'wamid.P', source: 'agent' })
    expect(recorded()).toMatchObject({ status: 'asked' })
  })

  it('picker send fails → unresolved ask_failed, carries on at the thread’s studio', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
    sendInteractiveOptions.mockRejectedValueOnce(new Error('window closed'))
    expect((await resolveNewSenderStudio(db, base)).action).toBe('unresolved')
    expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'ask_failed' })
  })

  it('asked + tap on a listed studio → by:picker; tap on an unknown id → treated as no answer (Review Focus 1)', async () => {
    const asked = { ...base, resolution: { status: 'asked' }, messageType: 'interactive', body: 'Hatch Street', message: { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'studio:a2' } } } }
    tapSignal.mockReturnValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    expect((await resolveNewSenderStudio(db, asked)).action).toBe('decided')
    expect(recorded()).toMatchObject({ by: 'picker', location_id: 'a2' })
    tapSignal.mockReturnValueOnce(null)
    classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
    expect((await resolveNewSenderStudio(db, asked)).action).toBe('unresolved')
    expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'no_answer' })
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
  })

  it('asked + a typed reply a day later → classifier once, then final; never a second picker (Review Focus 2)', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked' }, body: 'the hatch one' })
    expect(r.action).toBe('decided')
    expect(recorded()).toMatchObject({ by: 'ai' })
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
  })

  it('a merge returns the target conversation id; a failed move records unresolved move_failed at the original studio', async () => {
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c9', merged: true }, error: null })
    expect(await resolveNewSenderStudio(db, base)).toEqual({ action: 'decided', locationId: 'a2', conversationId: 'c9' })
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'dup' } })
    expect(await resolveNewSenderStudio(db, base)).toEqual({ action: 'unresolved', locationId: 'a1', conversationId: 'c1' })
    expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'move_failed' })
  })

  it('request_welcome: no text → no classifier; ad or picker as usual', async () => {
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    const r = await resolveNewSenderStudio(db, { ...base, messageType: 'request_welcome', body: '[Opened the chat]', message: { type: 'request_welcome' } })
    expect(r.action).toBe('asked')
    expect(classifyStudio).not.toHaveBeenCalled()
  })

  it('a malformed studio_resolution.status behaves like no record: only decided/unresolved are final, only asked is asked', async () => {
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'half-done' } })
    expect(r.action).toBe('asked')
    expect(sendInteractiveOptions).toHaveBeenCalledTimes(1)
    expect(tapSignal).not.toHaveBeenCalled()
  })

  it('never throws: an internal error → skip, logged', async () => {
    readPickerConfig.mockRejectedValueOnce(new Error('boom'))
    expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
  })
})
