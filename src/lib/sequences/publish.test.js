import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { publishSequence } from './publish'

const SEQ = 'a0000000-0000-0000-0000-000000000001'
const LOC = 'c0000000-0000-0000-0000-000000000003'
const emailGraph = { version: 1, trigger: { type: 'manual', config: {} }, nodes: [{ id: 'n1', type: 'email', config: { subject: 'hi' } }], edges: [{ from: 'trigger', to: 'n1' }] }
const waGraph = { version: 1, trigger: { type: 'manual', config: {} }, nodes: [{ id: 'n1', type: 'whatsapp', config: { template_id: 'wt-1' } }], edges: [{ from: 'trigger', to: 'n1' }] }

function mockDb({ stored = { location_id: LOC, graph: null, draft_graph: null }, templates = [], templateError = null } = {}) {
  const rpc = vi.fn(() => Promise.resolve({ data: {}, error: null }))
  const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }))
  const db = {
    rpc,
    from: vi.fn((table) => {
      if (table === 'email_sequences') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: stored, error: null })) })) })),
          update,
        }
      }
      if (table === 'whatsapp_templates') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: templateError ? null : templates, error: templateError })) })) })) }
      }
      if (table === 'sequence_steps') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [], error: null })) })) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, rpc, update }
}

beforeEach(() => vi.clearAllMocks())

describe('publishSequence', () => {
  it('notFound404', async () => {
    const { db, rpc } = mockDb({ stored: null })
    expect(await publishSequence(db, { sequenceId: SEQ })).toMatchObject({ ok: false, status: 404 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('nothingToPublish400', async () => {
    const { db } = mockDb()
    expect(await publishSequence(db, { sequenceId: SEQ })).toMatchObject({ ok: false, status: 400 })
  })

  it('templateReadFailure503', async () => {
    const { db, rpc } = mockDb({ templateError: { message: 'boom' } })
    const r = await publishSequence(db, { sequenceId: SEQ, graph: waGraph })
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(r.error).toContain('Nothing was published')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pendingTemplate422', async () => {
    const { db, rpc } = mockDb({ templates: [{ id: 'wt-1', name: 'T', status: 'PENDING', components: [{ type: 'BODY', text: 'hi' }] }] })
    const r = await publishSequence(db, { sequenceId: SEQ, graph: waGraph })
    expect(r).toMatchObject({ ok: false, status: 422 })
    expect(r.issues.length).toBeGreaterThan(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('publishesAndActivates', async () => {
    const { db, rpc, update } = mockDb()
    const r = await publishSequence(db, { sequenceId: SEQ, graph: emailGraph })
    expect(r).toEqual({ ok: true, steps: 1 })
    expect(rpc).toHaveBeenCalledWith('publish_sequence_steps', expect.objectContaining({ p_sequence_id: SEQ }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ draft_graph: null, status: 'active' }))
  })
})
