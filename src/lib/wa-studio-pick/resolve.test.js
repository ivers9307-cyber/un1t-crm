// WASTUDIOPICK.1 — the resolver orchestrator. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('./config', () => ({ readPickerConfig: vi.fn(), PICKER_ID_PREFIX: 'studio:' }))
vi.mock('./signals', () => ({ adSignal: vi.fn(), replySignal: vi.fn(), tapSignal: vi.fn() }))
vi.mock('./classify', () => ({ classifyStudio: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendInteractiveOptions: vi.fn() }))
vi.mock('@/lib/agent/core', () => ({ AGENT_MESSAGE_SOURCE: 'agent', stripEmDashes: (s) => String(s).replace(/\u2014/g, '-') }))
vi.mock('../log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
import { logError } from '../log'
import { readPickerConfig } from './config'
import { adSignal, replySignal, tapSignal } from './signals'
import { classifyStudio } from './classify'
import { sendInteractiveOptions } from '@/lib/whatsapp'
import { resolveNewSenderStudio } from './resolve.js'

const CFG = { enabled: true, question: 'Which studio?', studios: [{ id: 'a1', label: 'Stillorgan' }, { id: 'a2', label: 'Hatch Street' }] }
const base = { conversationId: 'c1', threadLocationId: 'a1', receivingLocationId: 'a1', contactId: null, resolution: null, messageType: 'text', body: 'hi', senderPhone: '353000000000', message: { type: 'text', text: { body: 'hi' } } }

let updates
let ops
let inserts
let claimResults
let claimError
let insertError
let db
const recorded = () => updates[updates.length - 1]
const lastOps = () => ops[ops.length - 1]
const FINAL_FILTER = 'studio_resolution.is.null,studio_resolution->>status.eq.asked'
// An update builder: records patch + chained filters, and is a thenable like supabase's.
function updateBuilder(patch) {
  const chain = []
  updates.push(patch.studio_resolution)
  ops.push(chain)
  const b = {
    eq: (...a) => { chain.push(['eq', ...a]); return b },
    is: (...a) => { chain.push(['is', ...a]); return b },
    or: (...a) => { chain.push(['or', ...a]); return b },
    filter: (...a) => { chain.push(['filter', ...a]); return b },
    select: (...a) => { chain.push(['select', ...a]); return b },
    then: (res, rej) => {
      const isClaim = chain.some((o) => o[0] === 'is')
      let out = { data: [{ id: 'row' }], error: null }
      if (isClaim) out = claimError ? { data: null, error: claimError } : (claimResults.shift() || out)
      return Promise.resolve(out).then(res, rej)
    },
  }
  return b
}
const messageInsert = () => inserts[inserts.length - 1]

beforeEach(() => {
  vi.resetAllMocks()
  updates = []
  ops = []
  inserts = []
  claimResults = []
  claimError = null
  insertError = null
  db = {
    rpc: vi.fn(),
    from: vi.fn((table) => {
      if (table === 'whatsapp_conversations') {
        return { update: vi.fn((patch) => updateBuilder(patch)) }
      }
      if (table === 'whatsapp_messages') {
        return { insert: vi.fn(async (row) => { inserts.push(row); return { error: insertError } }) }
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
  it('reads the picker for the receiving studio and number (WAORGNUMBER.5)', async () => {
    await resolveNewSenderStudio(db, { ...base, receivingNumberId: 'n1' })
    expect(readPickerConfig).toHaveBeenCalledWith(db, base.receivingLocationId, 'n1')
  })

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

  it('studio labels are scrubbed of em-dashes like the question (F5)', async () => {
    readPickerConfig.mockResolvedValueOnce({ ...CFG, studios: [CFG.studios[0], { id: 'a2', label: 'Hatch \u2014 St' }] })
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    await resolveNewSenderStudio(db, base)
    expect(sendInteractiveOptions.mock.calls[0][2]).toEqual([{ id: 'studio:a1', title: 'Stillorgan' }, { id: 'studio:a2', title: 'Hatch - St' }])
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

  it('a burst of first messages sends exactly ONE picker: the loser of the claim returns asked and stays quiet', async () => {
    claimResults = [{ data: [{ id: 'c1' }], error: null }, { data: [], error: null }]
    sendInteractiveOptions.mockResolvedValue({ messageId: 'wamid.P' })
    const [a, b] = await Promise.all([resolveNewSenderStudio(db, base), resolveNewSenderStudio(db, base)])
    expect(sendInteractiveOptions).toHaveBeenCalledTimes(1)
    expect([a.action, b.action]).toEqual(['asked', 'asked'])
    expect(inserts).toHaveLength(1)
    // the claim is a compare-and-set on a still-null resolution
    expect(ops.slice(0, 2).every((o) => o.some((x) => x[0] === 'is' && x[1] === 'studio_resolution' && x[2] === null))).toBe(true)
  })

  it('a claim write error: no picker, carries on (skip)', async () => {
    claimError = { message: 'db down' }
    const r = await resolveNewSenderStudio(db, base)
    expect(r).toEqual({ action: 'skip', locationId: 'a1', conversationId: 'c1' })
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })

  it('a failed message-log insert after a successful send is logged only: still asked, status not flipped', async () => {
    insertError = { message: 'insert failed' }
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    const r = await resolveNewSenderStudio(db, base)
    expect(r.action).toBe('asked')
    expect(recorded()).toMatchObject({ status: 'asked' })
    expect(updates).toHaveLength(1)
    expect(logError).toHaveBeenCalled()
  })

  it('ask_failed overwrites the claim unconditionally (we own it)', async () => {
    sendInteractiveOptions.mockRejectedValueOnce(new Error('window closed'))
    await resolveNewSenderStudio(db, base)
    expect(lastOps().map((o) => o[0])).toEqual(['eq'])
  })

  it('a burst sibling already moved the thread (same_studio) → decided, not move_failed', async () => {
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'same_studio' } })
    const r = await resolveNewSenderStudio(db, base)
    expect(r).toEqual({ action: 'decided', locationId: 'a2', conversationId: 'c1' })
    expect(recorded()).toMatchObject({ status: 'decided', by: 'ad', location_id: 'a2' })
  })

  it('every final write is conditional on the row not already being final', async () => {
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    await resolveNewSenderStudio(db, base)
    expect(lastOps()).toContainEqual(['or', FINAL_FILTER])
    adSignal.mockResolvedValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'dup' } })
    await resolveNewSenderStudio(db, base)
    expect(recorded()).toMatchObject({ reason: 'move_failed' })
    expect(lastOps()).toContainEqual(['or', FINAL_FILTER])
    await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked' } })
    expect(recorded()).toMatchObject({ reason: 'no_answer' })
    expect(lastOps()).toContainEqual(['or', FINAL_FILTER])
  })

  it('asked + a reaction/sticker/voice note does not burn the question: stays asked, first one counted, no classifier (F7)', async () => {
    for (const messageType of ['reaction', 'sticker', 'audio', 'unsupported', 'system', 'request_welcome']) {
      const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked', at: '2026-10-15T10:00:00.000Z' }, messageType, body: '[x]', message: { type: messageType } })
      expect(r.action).toBe('asked')
      expect(recorded()).toEqual({ status: 'asked', at: '2026-10-15T10:00:00.000Z', nonanswers: 1 })
    }
    expect(updates).toHaveLength(6)
    expect(classifyStudio).not.toHaveBeenCalled()
    expect(sendInteractiveOptions).not.toHaveBeenCalled()
  })

  it('the first non-answer is a compare-and-set on a still-asked row, keeping the original at (F7)', async () => {
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked', at: '2026-10-15T10:00:00.000Z' }, messageType: 'reaction', body: '[x]', message: { type: 'reaction', timestamp: String(Date.parse('2026-10-15T10:00:00.000Z') / 1000 + 60) } })
    expect(r).toEqual({ action: 'asked', locationId: 'a1', conversationId: 'c1' })
    expect(lastOps()).toContainEqual(['eq', 'id', 'c1'])
    expect(lastOps()).toContainEqual(['filter', 'studio_resolution->>status', 'eq', 'asked'])
  })

  it('a second non-answer ends it: unresolved no_answer, conditional final write, Mia handles it (F7)', async () => {
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked', at: '2026-10-15T10:00:00.000Z', nonanswers: 1 }, messageType: 'audio', body: '[Voice note]', message: { type: 'audio' } })
    expect(r).toEqual({ action: 'unresolved', locationId: 'a1', conversationId: 'c1' })
    expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'no_answer' })
    expect(lastOps()).toContainEqual(['or', FINAL_FILTER])
    expect(classifyStudio).not.toHaveBeenCalled()
  })

  it('a non-answer sent before the picker is not counted (F1 before F7)', async () => {
    const at = '2026-10-15T10:00:00.000Z'
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked', at }, messageType: 'reaction', body: '[x]', message: { type: 'reaction', timestamp: String(Date.parse(at) / 1000 - 1) } })
    expect(r.action).toBe('asked')
    expect(updates).toHaveLength(0)
  })

  it('a failed non-answer count write is logged and the question stays open (F7)', async () => {
    db.from = vi.fn(() => ({ update: vi.fn((patch) => { updates.push(patch.studio_resolution); const b = { eq: () => b, filter: () => b, select: () => b, then: (res, rej) => Promise.resolve({ data: null, error: { message: 'db down' } }).then(res, rej) }; return b }) }))
    const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked', at: '2026-10-15T10:00:00.000Z' }, messageType: 'sticker', body: '[x]', message: { type: 'sticker' } })
    expect(r.action).toBe('asked')
    expect(logError).toHaveBeenCalled()
  })

  it('a body that starts with a bracket is still text: classified', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    await resolveNewSenderStudio(db, { ...base, body: '[urgent] is hatch open?' })
    expect(classifyStudio).toHaveBeenCalledWith(expect.objectContaining({ text: '[urgent] is hatch open?' }))
  })

  it('a template quick-reply tap (type button) with readable text is classified (F6)', async () => {
    classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    const r = await resolveNewSenderStudio(db, { ...base, messageType: 'button', body: 'Hatch Street trial', message: { type: 'button', button: { text: 'Hatch Street trial', payload: 'Hatch Street trial' } } })
    expect(classifyStudio).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hatch Street trial' }))
    expect(r.action).toBe('decided')
  })

  it('a flow (nfm_reply) answer is not free text: never classified', async () => {
    sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
    const r = await resolveNewSenderStudio(db, { ...base, messageType: 'interactive', body: '{"x":1}', message: { type: 'interactive', interactive: { type: 'nfm_reply' } } })
    expect(r.action).toBe('asked')
    expect(classifyStudio).not.toHaveBeenCalled()
  })

  // F1 — a message typed before (or as) the picker went out is not an answer to it.
  const AT = '2026-10-15T10:00:00.000Z'
  const secs = (offsetMs) => String(Math.floor((Date.parse(AT) + offsetMs) / 1000))
  const askedAt = (offsetMs, extra = {}) => ({ ...base, resolution: { status: 'asked', at: AT }, body: 'the hatch one', message: { type: 'text', text: { body: 'the hatch one' }, timestamp: secs(offsetMs) }, ...extra })

  it('asked + a text sent before the picker → asked, no classifier, no write (F1)', async () => {
    const r = await resolveNewSenderStudio(db, askedAt(-2000))
    expect(r).toEqual({ action: 'asked', locationId: 'a1', conversationId: 'c1' })
    expect(classifyStudio).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('asked + a text within 5s of the claim is still before the picker; after that it is an answer (F1)', async () => {
    expect((await resolveNewSenderStudio(db, askedAt(5000))).action).toBe('asked')
    expect(classifyStudio).not.toHaveBeenCalled()
    classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    expect((await resolveNewSenderStudio(db, askedAt(10000))).action).toBe('decided')
    expect(classifyStudio).toHaveBeenCalledTimes(1)
    expect(recorded()).toMatchObject({ status: 'decided', by: 'ai' })
  })

  it('a tap is always judged as a tap, whatever its timestamp (F1)', async () => {
    tapSignal.mockReturnValueOnce('a2')
    db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
    const r = await resolveNewSenderStudio(db, askedAt(-60000, { messageType: 'interactive', body: 'Hatch Street', message: { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'studio:a2' } }, timestamp: secs(-60000) } }))
    expect(r.action).toBe('decided')
    expect(recorded()).toMatchObject({ by: 'picker', location_id: 'a2' })
  })

  it('an unparseable timestamp or claim time is treated as an answer (F1)', async () => {
    for (const ctx of [askedAt(-2000, { resolution: { status: 'asked', at: 'not a date' } }), { ...askedAt(0), message: { type: 'text', timestamp: 'soon' } }]) {
      classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
      db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
      expect((await resolveNewSenderStudio(db, ctx)).action).toBe('decided')
    }
    expect(classifyStudio).toHaveBeenCalledTimes(2)
  })

  it('never throws: an internal error → skip, logged', async () => {
    readPickerConfig.mockRejectedValueOnce(new Error('boom'))
    expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
  })
})
