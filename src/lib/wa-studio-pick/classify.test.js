// WASTUDIOPICK.1 — one-message studio classifier. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/usage-caps', () => ({ getAiCapStatus: vi.fn(async () => ({ capped: false })) }))
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { anthropicMessages } from '@/lib/anthropic'
import { logWarn } from '../log'
import { getAiCapStatus } from '@/lib/usage-caps'
import { AGENT_MODEL } from '@/lib/agent/auto-reply'
import { classifyStudio } from './classify.js'

const STUDIOS = [{ id: 'a1', name: 'UN1T Stillorgan', label: 'Stillorgan', keywords: ['stillorgan'] }, { id: 'a2', name: 'UN1T Hatch Street', label: 'Hatch Street', keywords: ['hatch'] }]
const reply = (obj, extra = {}) => ({ res: { ok: true }, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra } })

beforeEach(() => {
  anthropicMessages.mockReset()
  logWarn.mockReset()
  getAiCapStatus.mockReset()
  getAiCapStatus.mockResolvedValue({ capped: false })
})

describe('classifyStudio', () => {
  it('a confident listed studio decides', async () => {
    anthropicMessages.mockResolvedValue(reply({ studio: 'a2', confident: true }))
    expect(await classifyStudio({ text: 'is the Hatch St one open Sunday?', studios: STUDIOS, locationId: 'a1' })).toEqual({ studioId: 'a2', reason: 'decided' })
    const [body, meta] = anthropicMessages.mock.calls[0]
    expect(body.model).toBe(AGENT_MODEL)
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.output_config.format.schema.properties.studio.enum).toEqual(['a1', 'a2', 'none'])
    expect(body.output_config.effort).toBe('low')
    expect(meta).toMatchObject({ locationId: 'a1', source: 'wa_studio_pick' })
    expect(meta.signal).toBeDefined()
  })
  it.each([
    ['not confident', reply({ studio: 'a2', confident: false }), 'unsure'],
    ['none', reply({ studio: 'none', confident: true }), 'unsure'],
    ['hallucinated id (Review Focus 4)', reply({ studio: 'a7', confident: true }), 'unsure'],
    ['bad JSON', { res: { ok: true }, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hatch' }] } }, 'unparseable'],
    ['refusal', reply({ studio: 'a2', confident: true }, { stop_reason: 'refusal' }), 'refused'],
    ['HTTP error', { res: { ok: false, status: 529 }, data: null }, 'call_failed'],
  ])('%s → unsure', async (_n, r, reason) => {
    anthropicMessages.mockResolvedValue(r)
    expect(await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).toEqual({ studioId: null, reason })
  })
  it('an HTTP refusal is logged with its status and a body snippet, still call_failed (F3)', async () => {
    anthropicMessages.mockResolvedValue({ res: { ok: false, status: 400, text: async () => `{"error":"bad request"}${'x'.repeat(500)}` }, data: null })
    expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('call_failed')
    expect(logWarn).toHaveBeenCalledWith('wa-studio-pick', 'classifier call refused', expect.objectContaining({ locationId: 'a1', status: 400 }))
    const { body } = logWarn.mock.calls[0][2]
    expect(body.startsWith('{"error":"bad request"}')).toBe(true)
    expect(body).toHaveLength(200)
  })
  it('an unreadable refusal body logs an empty snippet, never throws (F3)', async () => {
    anthropicMessages.mockResolvedValue({ res: { ok: false, status: 529, text: async () => { throw new Error('used') } }, data: null })
    expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('call_failed')
    expect(logWarn).toHaveBeenCalledWith('wa-studio-pick', 'classifier call refused', { locationId: 'a1', status: 529, body: '' })
  })
  it('a thrown/aborted call → call_failed; empty text → empty without a call; cap reached → capped without a call', async () => {
    anthropicMessages.mockRejectedValue(new Error('aborted'))
    expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('call_failed')
    anthropicMessages.mockClear()
    expect((await classifyStudio({ text: '  ', studios: STUDIOS, locationId: 'a1' })).reason).toBe('empty')
    getAiCapStatus.mockResolvedValueOnce({ capped: true })
    expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('capped')
    expect(anthropicMessages).not.toHaveBeenCalled()
  })
})
