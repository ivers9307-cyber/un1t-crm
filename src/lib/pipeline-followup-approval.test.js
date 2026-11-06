import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/sequences/publish', () => ({ publishSequence: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { publishSequence } from '@/lib/sequences/publish'
import { logError } from '@/lib/log'
import { onTemplateStatusForFollowups, graphTemplateIds } from '@/lib/pipeline-followup-approval'

const LOC = 'loc-1'
const OTHER_LOC = 'loc-2'

// In-memory tables behind a chainable supabase-ish builder (Task 4's shape,
// plus order/range). Every query is filtered by its .eq/.in filters, so a lib
// that forgets to scope by location finds the wrong rows (or none).
function fakeDb(seed = {}, { fail = {}, failWhen, beforeUpdate } = {}) {
  const tables = {
    pipeline_stage_followups: [],
    email_sequences: [],
    whatsapp_templates: [],
    ...seed,
  }
  const matches = (row, filters) => filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : val.includes(row[col])))
  const ops = []

  function run(q) {
    ops.push(q)
    const key = `${q.table}.${q.op}`
    if (fail[key]) return { data: null, error: fail[key] }
    const forced = failWhen?.(q)
    if (forced) return { data: null, error: forced }
    const rows = tables[q.table]
    if (!rows) throw new Error(`unexpected table ${q.table}`)
    let out
    if (q.op === 'select') {
      out = rows.filter((r) => matches(r, q.filters))
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1)
    } else if (q.op === 'update') {
      if (beforeUpdate) beforeUpdate(q, tables)
      out = rows.filter((r) => matches(r, q.filters))
      out.forEach((r) => Object.assign(r, q.payload))
    }
    return { data: out.map((r) => ({ ...r })), error: null }
  }

  const db = {
    from: vi.fn((table) => {
      const q = { table, op: 'select', filters: [], payload: null, range: null }
      const b = {
        select() { return b },
        update(p) { q.op = 'update'; q.payload = p; return b },
        eq(c, v) { q.filters.push(['eq', c, v]); return b },
        in(c, v) { q.filters.push(['in', c, v]); return b },
        order() { return b },
        range(from, to) { q.range = [from, to]; return b },
        then(res, rej) { return Promise.resolve(run(q)).then(res, rej) },
      }
      return b
    }),
  }
  return { db, tables, ops }
}

const waNode = (id, templateId) => ({ id, type: 'whatsapp', config: { template_id: templateId } })
const graphOf = (...templateIds) => ({
  trigger: { type: 'pipeline_stage_change', config: { to_status: 'reset_new' } },
  nodes: templateIds.map((t, i) => waNode(`n${i}`, t)),
  edges: [],
})

const followup = (over = {}) => ({
  id: 'fu-1',
  location_id: LOC,
  pipeline_id: 'pipe-1',
  stage_id: 'stage-1',
  sequence_id: 'seq-1',
  whatsapp_template_id: 'wt-1',
  pack_key: 'book_first_class',
  state: 'awaiting_approval',
  want_live: true,
  updated_at: '2026-11-01T00:00:00.000Z',
  ...over,
})
const sequence = (over = {}) => ({ id: 'seq-1', location_id: LOC, graph: null, draft_graph: graphOf('wt-1'), ...over })
const tpl = (id, status, location_id = LOC) => ({ id, status, location_id })

beforeEach(() => {
  vi.clearAllMocks()
  publishSequence.mockResolvedValue({ ok: true, steps: 3 })
})

describe('graphTemplateIds', () => {
  it('reads template_id and whatsapp_template_id off whatsapp nodes only', () => {
    const g = { nodes: [waNode('a', 'wt-1'), { id: 'b', type: 'whatsapp', config: { whatsapp_template_id: 'wt-2' } }, { id: 'c', type: 'email', config: { template_id: 'em-1' } }] }
    expect(graphTemplateIds(g)).toEqual(['wt-1', 'wt-2'])
    expect(graphTemplateIds(null)).toEqual([])
  })
})

describe('onTemplateStatusForFollowups', () => {
  it('publishesWhenApproved', async () => {
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    })
    const r = await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(r).toEqual({ published: 1, rejected: 0 })
    expect(publishSequence).toHaveBeenCalledTimes(1)
    expect(publishSequence).toHaveBeenCalledWith(db, { sequenceId: 'seq-1' })
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(tables.pipeline_stage_followups[0].updated_at).not.toBe('2026-11-01T00:00:00.000Z')
  })

  it('publishesOnlyWhenAllTemplatesApproved', async () => {
    // trial_done: the row links the first template, the graph sends two.
    const seed = () => ({
      pipeline_stage_followups: [followup({ pack_key: 'trial_done' })],
      email_sequences: [sequence({ draft_graph: graphOf('wt-1', 'wt-2') })],
    })
    // The second template approved first: still waiting on the first.
    const first = fakeDb({ ...seed(), whatsapp_templates: [tpl('wt-1', 'PENDING'), tpl('wt-2', 'APPROVED')] })
    expect(await onTemplateStatusForFollowups(first.db, { id: 'wt-2', location_id: LOC }, 'APPROVED')).toEqual({ published: 0, rejected: 0 })
    expect(publishSequence).not.toHaveBeenCalled()
    expect(first.tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')

    // An APPROVED template of the same id at ANOTHER studio does not count.
    const cross = fakeDb({ ...seed(), whatsapp_templates: [tpl('wt-1', 'APPROVED'), tpl('wt-2', 'APPROVED', OTHER_LOC)] })
    expect(await onTemplateStatusForFollowups(cross.db, { id: 'wt-1', location_id: LOC }, 'APPROVED')).toEqual({ published: 0, rejected: 0 })
    expect(publishSequence).not.toHaveBeenCalled()

    // Both approved: it publishes, found by the SECOND template's id.
    const both = fakeDb({ ...seed(), whatsapp_templates: [tpl('wt-1', 'APPROVED'), tpl('wt-2', 'APPROVED')] })
    expect(await onTemplateStatusForFollowups(both.db, { id: 'wt-2', location_id: LOC }, 'APPROVED')).toEqual({ published: 1, rejected: 0 })
    expect(publishSequence).toHaveBeenCalledTimes(1)
    expect(both.tables.pipeline_stage_followups[0].state).toBe('live')
  })

  it('touches only the template\'s own studio and want_live follow-ups', async () => {
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [
        followup({ id: 'fu-other', location_id: OTHER_LOC, sequence_id: 'seq-other' }),
        followup({ id: 'fu-nolive', want_live: false, sequence_id: 'seq-2' }),
      ],
      email_sequences: [sequence({ id: 'seq-other', location_id: OTHER_LOC }), sequence({ id: 'seq-2' })],
      whatsapp_templates: [tpl('wt-1', 'APPROVED'), tpl('wt-1', 'APPROVED', OTHER_LOC)],
    })
    expect(await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')).toEqual({ published: 0, rejected: 0 })
    expect(publishSequence).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups.map((f) => f.state)).toEqual(['awaiting_approval', 'awaiting_approval'])
  })

  it('concurrentApprovalPublishesOnce', async () => {
    // Someone else (the installer, or a second delivery) claims the row
    // between our read and our CAS: the CAS matches 0 rows and we skip.
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    }, {
      beforeUpdate: (q, t) => {
        if (q.table === 'pipeline_stage_followups' && q.payload.state === 'live') t.pipeline_stage_followups[0].state = 'live'
      },
    })
    const r = await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(r).toEqual({ published: 0, rejected: 0 })
    expect(publishSequence).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups[0].state).toBe('live')

    // And two hook runs in a row publish once between them.
    const second = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    })
    const a = await onTemplateStatusForFollowups(second.db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    const b = await onTemplateStatusForFollowups(second.db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(a.published + b.published).toBe(1)
    expect(publishSequence).toHaveBeenCalledTimes(1)
  })

  it('rejectedMarksAwaiting', async () => {
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [
        followup({ id: 'fu-wait' }),
        followup({ id: 'fu-live', state: 'live', sequence_id: 'seq-2' }),
        // Found by the graph, not the row's first-template link.
        followup({ id: 'fu-second', whatsapp_template_id: 'wt-9', sequence_id: 'seq-3', want_live: false }),
        followup({ id: 'fu-other', location_id: OTHER_LOC, sequence_id: 'seq-other' }),
        followup({ id: 'fu-unrelated', whatsapp_template_id: 'wt-7', sequence_id: 'seq-4' }),
      ],
      email_sequences: [
        sequence(),
        sequence({ id: 'seq-2' }),
        sequence({ id: 'seq-3', draft_graph: graphOf('wt-9', 'wt-1') }),
        sequence({ id: 'seq-other', location_id: OTHER_LOC }),
        sequence({ id: 'seq-4', draft_graph: graphOf('wt-7') }),
      ],
    })
    const r = await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'REJECTED')
    expect(r).toEqual({ published: 0, rejected: 2 })
    const state = Object.fromEntries(tables.pipeline_stage_followups.map((f) => [f.id, f.state]))
    expect(state).toEqual({
      'fu-wait': 'rejected',
      'fu-live': 'live',
      'fu-second': 'rejected',
      'fu-other': 'awaiting_approval',
      'fu-unrelated': 'awaiting_approval',
    })
    expect(publishSequence).not.toHaveBeenCalled()

    // DISABLED does the same; PAUSED (temporary) does nothing.
    const dis = fakeDb({ pipeline_stage_followups: [followup()], email_sequences: [sequence()] })
    expect(await onTemplateStatusForFollowups(dis.db, { id: 'wt-1', location_id: LOC }, 'DISABLED')).toEqual({ published: 0, rejected: 1 })
    const paused = fakeDb({ pipeline_stage_followups: [followup()], email_sequences: [sequence()] })
    expect(await onTemplateStatusForFollowups(paused.db, { id: 'wt-1', location_id: LOC }, 'PAUSED')).toEqual({ published: 0, rejected: 0 })
    expect(paused.tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('publishFailureRevertsState', async () => {
    publishSequence.mockResolvedValue({ ok: false, status: 422, error: 'Flow has problems' })
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    })
    const r = await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(r).toEqual({ published: 0, rejected: 0 })
    expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
    expect(logError).toHaveBeenCalledWith('pipeline-followup-approval', expect.stringContaining('publish failed'), expect.objectContaining({ followupId: 'fu-1', err: 'Flow has problems' }))

    // A publish that throws is treated the same way.
    publishSequence.mockRejectedValue(new Error('boom'))
    const thrown = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    })
    await onTemplateStatusForFollowups(thrown.db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(thrown.tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('rejectIgnoresTemplateNoLongerInGraph', async () => {
    // The row still links wt-1 (its first template at install), but the
    // sequence's graph now sends wt-5 only: wt-1's fate is not this
    // follow-up's any more.
    const seed = () => ({
      pipeline_stage_followups: [followup({ whatsapp_template_id: 'wt-1' })],
      email_sequences: [sequence({ draft_graph: graphOf('wt-5') })],
      whatsapp_templates: [tpl('wt-1', 'APPROVED'), tpl('wt-5', 'PENDING')],
    })
    const rej = fakeDb(seed())
    expect(await onTemplateStatusForFollowups(rej.db, { id: 'wt-1', location_id: LOC }, 'REJECTED')).toEqual({ published: 0, rejected: 0 })
    expect(rej.tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')

    // Nor does its approval publish (wt-5 is still pending, and wt-1 is not sent).
    const app = fakeDb(seed())
    expect(await onTemplateStatusForFollowups(app.db, { id: 'wt-1', location_id: LOC }, 'APPROVED')).toEqual({ published: 0, rejected: 0 })
    expect(publishSequence).not.toHaveBeenCalled()

    // With NO readable sequence the row's link is all there is, and it counts.
    const bare = fakeDb({ pipeline_stage_followups: [followup({ whatsapp_template_id: 'wt-1', sequence_id: 'seq-gone' })] })
    expect(await onTemplateStatusForFollowups(bare.db, { id: 'wt-1', location_id: LOC }, 'REJECTED')).toEqual({ published: 0, rejected: 1 })
  })

  it('a publish failure whose revert also fails is logged as stuck live', async () => {
    publishSequence.mockResolvedValue({ ok: false, status: 422, error: 'Flow has problems' })
    const { db, tables } = fakeDb({
      pipeline_stage_followups: [followup()],
      email_sequences: [sequence()],
      whatsapp_templates: [tpl('wt-1', 'APPROVED')],
    }, {
      failWhen: (q) => (q.table === 'pipeline_stage_followups' && q.op === 'update' && q.payload?.state === 'awaiting_approval'
        ? { message: 'db down' } : null),
    })
    const r = await onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')
    expect(r).toEqual({ published: 0, rejected: 0 })
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(logError).toHaveBeenCalledWith(
      'pipeline-followup-approval',
      expect.stringContaining('reads live over a draft sequence'),
      expect.objectContaining({ followupId: 'fu-1', err: 'Flow has problems', revertErr: 'db down' }),
    )
    expect(logError).not.toHaveBeenCalledWith('pipeline-followup-approval', 'publish failed; follow-up left awaiting approval', expect.anything())
  })

  it('neverThrows', async () => {
    for (const failKey of ['pipeline_stage_followups.select', 'email_sequences.select', 'whatsapp_templates.select']) {
      const { db, tables } = fakeDb({
        pipeline_stage_followups: [followup()],
        email_sequences: [sequence()],
        whatsapp_templates: [tpl('wt-1', 'APPROVED')],
      }, { fail: { [failKey]: { message: 'db down' } } })
      await expect(onTemplateStatusForFollowups(db, { id: 'wt-1', location_id: LOC }, 'APPROVED')).resolves.toEqual({ published: 0, rejected: 0 })
      expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
    }
    const rej = fakeDb({ pipeline_stage_followups: [followup()], email_sequences: [sequence()] }, { fail: { 'pipeline_stage_followups.update': { message: 'db down' } } })
    await expect(onTemplateStatusForFollowups(rej.db, { id: 'wt-1', location_id: LOC }, 'REJECTED')).resolves.toEqual({ published: 0, rejected: 0 })

    const boom = { from: () => { throw new Error('client exploded') } }
    await expect(onTemplateStatusForFollowups(boom, { id: 'wt-1', location_id: LOC }, 'APPROVED')).resolves.toEqual({ published: 0, rejected: 0 })
    await expect(onTemplateStatusForFollowups(boom, null, 'APPROVED')).resolves.toEqual({ published: 0, rejected: 0 })
    expect(logError).toHaveBeenCalled()
  })
})
