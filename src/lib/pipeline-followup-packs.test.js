import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp-template-submit', () => ({ submitWhatsappTemplate: vi.fn() }))
vi.mock('@/lib/sequences/publish', () => ({ publishSequence: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { submitWhatsappTemplate } from '@/lib/whatsapp-template-submit'
import { publishSequence } from '@/lib/sequences/publish'
import { installFollowupPack } from '@/lib/pipeline-followup-packs'

const LOC = 'loc-1'
const OTHER_LOC = 'loc-2'
const PIPE = 'pipe-1'
const STAGE = 'stage-1'
const USER = 'user-1'

// In-memory tables behind a chainable supabase-ish builder. Every query is
// filtered by its .eq/.in filters, so a lib that forgets to scope by
// location simply finds the wrong rows (or none).
// `failWhen(q)` returns an error for one specific query; `afterOp(q, tables)`
// runs after a query (to simulate a webhook landing mid-install).
let lastTables = null
function fakeDb(seed = {}, { fail = {}, failWhen, afterOp } = {}) {
  const tables = {
    pipelines: [{ id: PIPE, key: 'reset', name: '14 Day Reset', location_id: LOC, board_type: 'offer' }],
    pipeline_stages: [{ id: STAGE, slug: 'reset_new', pipeline_id: PIPE, location_id: LOC }],
    locations: [{ id: LOC, name: 'UN1T Stillorgan' }, { id: OTHER_LOC, name: 'UN1T Hatch Street' }],
    pipeline_stage_followups: [],
    email_sequences: [],
    whatsapp_templates: [],
    ...seed,
  }
  let n = 0
  const matches = (row, filters) => filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : val.includes(row[col])))
  const ops = []

  function run(q) {
    const res = exec(q)
    if (afterOp) afterOp(q, tables)
    return res
  }

  function exec(q) {
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
    } else if (q.op === 'insert') {
      const row = { id: `${q.table}-${++n}`, ...q.payload }
      if (q.table === 'pipeline_stage_followups'
        && rows.some((r) => r.stage_id === row.stage_id && r.pack_key === row.pack_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } }
      }
      rows.push(row)
      out = [row]
    } else if (q.op === 'update') {
      out = rows.filter((r) => matches(r, q.filters))
      out.forEach((r) => Object.assign(r, q.payload))
    } else if (q.op === 'delete') {
      out = rows.filter((r) => matches(r, q.filters))
      tables[q.table] = rows.filter((r) => !out.includes(r))
    }
    if (q.single === 'maybe') return { data: out[0] ?? null, error: null }
    if (q.single === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not one row' } }
    return { data: out.map((r) => ({ ...r })), error: null }
  }

  const db = {
    from: vi.fn((table) => {
      const q = { table, op: 'select', filters: [], payload: null, single: null }
      const b = {
        select() { return b },
        insert(p) { q.op = 'insert'; q.payload = p; return b },
        update(p) { q.op = 'update'; q.payload = p; return b },
        delete() { q.op = 'delete'; return b },
        eq(c, v) { q.filters.push(['eq', c, v]); return b },
        in(c, v) { q.filters.push(['in', c, v]); return b },
        maybeSingle() { q.single = 'maybe'; return Promise.resolve(run(q)) },
        single() { q.single = 'single'; return Promise.resolve(run(q)) },
        then(res, rej) { return Promise.resolve(run(q)).then(res, rej) },
      }
      return b
    }),
  }
  lastTables = tables
  return { db, tables, ops }
}

// One-template pack (paid_trial_offer / book_first_class) and a two-template
// pack (paid_trial_offer / trial_done).
const args = (over = {}) => ({
  locationId: LOC,
  pipelineId: PIPE,
  stage: { id: STAGE, slug: 'reset_new' },
  recipeKey: 'paid_trial_offer',
  packKey: 'book_first_class',
  render: { studioName: 'UN1T Stillorgan', offerName: '14 Day Reset', durationDays: 14, signer: 'Garrett', bookingFlowId: 'flow-1' },
  createdBy: USER,
  ...over,
})

// Like the real helper, a submit saves the row; the installer re-reads it.
let tplN = 0
function submitsOk(status = 'PENDING') {
  submitWhatsappTemplate.mockImplementation(async (_db, t) => {
    const template = { id: `wt-${++tplN}`, name: t.name, status, location_id: t.locationId }
    lastTables?.whatsapp_templates.push({ ...template })
    return { ok: true, template }
  })
}
const waIdsOf = (graph) => graph.nodes.filter((x) => x.type === 'whatsapp').map((x) => x.config.template_id)

beforeEach(() => {
  vi.clearAllMocks()
  tplN = 0
  publishSequence.mockResolvedValue({ ok: true, steps: 5 })
})

describe('installFollowupPack', () => {
  it('installsTemplatesSequenceAndLink', async () => {
    submitsOk('PENDING')
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args({ packKey: 'trial_done' }))

    expect(r.ok).toBe(true)
    expect(r.created).toBe(true)

    // Both templates submitted on THIS studio, named per the recipe rule.
    expect(submitWhatsappTemplate).toHaveBeenCalledTimes(2)
    const names = submitWhatsappTemplate.mock.calls.map(([, t]) => t.name)
    expect(names).toEqual(['un1t_stillorgan_reset_trial_done_main', 'un1t_stillorgan_reset_trial_done_followup'])
    for (const [, t] of submitWhatsappTemplate.mock.calls) {
      expect(t).toMatchObject({ locationId: LOC, category: 'MARKETING', language: 'en', createdBy: USER })
    }

    // One draft sequence whose row-level trigger matches the graph trigger.
    expect(tables.email_sequences).toHaveLength(1)
    const seq = tables.email_sequences[0]
    expect(seq).toMatchObject({
      location_id: LOC,
      name: '14 Day Reset · End of trial',
      trigger_type: 'pipeline_stage_change',
      trigger_config: { to_status: 'reset_new' },
      status: 'draft',
      created_by: USER,
    })
    expect(seq.draft_graph.trigger).toEqual({ type: 'pipeline_stage_change', config: { to_status: 'reset_new' } })
    const waIds = seq.draft_graph.nodes.filter((x) => x.type === 'whatsapp').map((x) => x.config.template_id)
    expect(new Set(waIds)).toEqual(new Set(['wt-1', 'wt-2']))

    // The stage link: first template, awaiting approval, pack_key + updated_at written.
    expect(tables.pipeline_stage_followups).toHaveLength(1)
    const link = tables.pipeline_stage_followups[0]
    expect(link).toMatchObject({
      location_id: LOC,
      pipeline_id: PIPE,
      stage_id: STAGE,
      sequence_id: seq.id,
      whatsapp_template_id: 'wt-1',
      pack_key: 'trial_done',
      state: 'awaiting_approval',
      want_live: true,
      created_by: USER,
    })
    expect(typeof link.updated_at).toBe('string')
    expect(r.followup).toMatchObject({ id: link.id, state: 'awaiting_approval' })

    // Templates still pending at Meta: nothing published yet.
    expect(publishSequence).not.toHaveBeenCalled()
  })

  it('refusesLegacyBoard', async () => {
    submitsOk()
    const { db, tables } = fakeDb({
      pipelines: [{ id: PIPE, key: 'paid_trial', name: '€39 Trial', location_id: LOC, board_type: null }],
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(r.error).toBe("This board is built in code and can't be changed here.")
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('refusesOtherStudioBoard', async () => {
    submitsOk()
    const { db, tables } = fakeDb({
      pipelines: [{ id: PIPE, key: 'reset', name: '14 Day Reset', location_id: OTHER_LOC, board_type: 'offer' }],
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('refuses a stage that is not on this board', async () => {
    submitsOk()
    const { db, tables } = fakeDb({
      pipeline_stages: [{ id: STAGE, slug: 'reset_new', pipeline_id: 'pipe-other', location_id: LOC }],
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('refuses a call with no stage', async () => {
    const { db, ops } = fakeDb()
    const r = await installFollowupPack(db, args({ stage: undefined }))
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(ops).toHaveLength(0)
  })

  it('existingFollowupReturned', async () => {
    submitsOk()
    const existing = {
      id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: 'seq-old',
      whatsapp_template_id: 'wt-old', pack_key: 'book_first_class', state: 'live', want_live: true,
      created_by: USER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    }
    const { db, tables } = fakeDb({ pipeline_stage_followups: [existing] })
    const r = await installFollowupPack(db, args())
    expect(r).toEqual({ ok: true, followup: existing, created: false })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.email_sequences).toHaveLength(0)
    expect(publishSequence).not.toHaveBeenCalled()
  })

  it('reinstallLinksExistingTemplate', async () => {
    // A rejected earlier install left the stage's row in 'rejected' and its
    // template saved here; a reinstall hits the name clash on that template.
    submitWhatsappTemplate.mockResolvedValue({
      ok: false, status: 409, code: 'name_clash', existing: { id: 'wt-saved' },
      error: 'That name is already used by UN1T Stillorgan on this WhatsApp account. Pick another name.',
    })
    const { db, tables } = fakeDb({
      whatsapp_templates: [{ id: 'wt-saved', location_id: LOC, status: 'PENDING' }],
      pipeline_stage_followups: [{
        id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: null,
        whatsapp_template_id: null, pack_key: 'book_first_class', state: 'draft', want_live: false,
      }],
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true })
    expect(tables.email_sequences).toHaveLength(1)
    const waIds = tables.email_sequences[0].draft_graph.nodes.filter((x) => x.type === 'whatsapp').map((x) => x.config.template_id)
    expect(waIds).toEqual(['wt-saved'])
    // The SAME row (one per stage + pack) now points at the new sequence.
    expect(tables.pipeline_stage_followups).toHaveLength(1)
    expect(tables.pipeline_stage_followups[0]).toMatchObject({
      id: 'fu-1', whatsapp_template_id: 'wt-saved', sequence_id: tables.email_sequences[0].id,
      state: 'awaiting_approval', want_live: true, pack_key: 'book_first_class',
    })
  })

  it('reinstall refuses to link a template Meta rejected', async () => {
    submitWhatsappTemplate.mockResolvedValue({
      ok: false, status: 409, code: 'name_clash', existing: { id: 'wt-saved' }, error: 'clash',
    })
    const { db, tables } = fakeDb({ whatsapp_templates: [{ id: 'wt-saved', location_id: LOC, status: 'REJECTED' }] })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'template_rejected' })
    // No promise that new wording would help: the name is fixed.
    expect(r.error).toBe("This step's WhatsApp template (un1t_stillorgan_reset_book_first_class_main) was rejected by Meta. Ask an admin to replace it before installing again.")
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('templateFailureCreatesNoSequence', async () => {
    // First template goes through, the second is refused by Meta.
    submitWhatsappTemplate
      .mockResolvedValueOnce({ ok: true, template: { id: 'wt-1', status: 'PENDING' } })
      .mockResolvedValueOnce({ ok: false, status: 400, error: 'Invalid parameter' })
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args({ packKey: 'trial_done' }))
    expect(r).toEqual({ ok: false, status: 400, error: 'Invalid parameter' })
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
    expect(publishSequence).not.toHaveBeenCalled()
  })

  it('passes a name clash with another studio through with its code', async () => {
    submitWhatsappTemplate.mockResolvedValue({ ok: false, status: 409, code: 'name_clash', error: 'used by UN1T Hatch Street' })
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args())
    expect(r).toEqual({ ok: false, status: 409, code: 'name_clash', error: 'used by UN1T Hatch Street' })
    expect(tables.email_sequences).toHaveLength(0)
  })

  it('a bad fill-in is a 400 before anything reaches Meta', async () => {
    submitsOk()
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args({ render: { ...args().render, offerName: 'Reset {{1}}' } }))
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.email_sequences).toHaveLength(0)
  })

  it('a failed link deletes the sequence it just created', async () => {
    submitsOk()
    const { db, tables } = fakeDb({}, { fail: { 'pipeline_stage_followups.insert': { message: 'boom' } } })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('a concurrent install wins the row: this one removes its sequence and says so', async () => {
    submitsOk()
    const { db, tables } = fakeDb({}, { fail: { 'pipeline_stage_followups.insert': { code: '23505', message: 'duplicate key' } } })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'install_raced' })
    expect(tables.email_sequences).toHaveLength(0)
  })

  it('alreadyApprovedPublishesAtInstall', async () => {
    submitsOk('APPROVED')
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true })
    expect(publishSequence).toHaveBeenCalledTimes(1)
    // Called WITHOUT `existing`: the helper loads the row by id.
    expect(publishSequence.mock.calls[0][1]).toEqual({ sequenceId: tables.email_sequences[0].id })
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(r.followup.state).toBe('live')
  })

  it('an approved install that fails to publish goes back to awaiting approval', async () => {
    submitsOk('APPROVED')
    publishSequence.mockResolvedValue({ ok: false, status: 422, error: 'Flow has problems' })
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true, publishError: 'Flow has problems' })
    expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
    expect(r.followup.state).toBe('awaiting_approval')
  })

  it('does not publish when wantLive is false, even if approved', async () => {
    submitsOk('APPROVED')
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args({ wantLive: false }))
    expect(r).toMatchObject({ ok: true, created: true })
    expect(publishSequence).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups[0]).toMatchObject({ state: 'awaiting_approval', want_live: false })
  })

  it('approvedDuringInstallPublishes', async () => {
    // Meta approves while the installer is still linking: the webhook's hook
    // ran before the row existed and found nothing to move. Submit said
    // PENDING, but the re-read after the link sees APPROVED and publishes.
    submitsOk('PENDING')
    const { db, tables } = fakeDb({}, {
      afterOp: (q, t) => {
        if (q.table === 'pipeline_stage_followups' && q.op === 'insert') {
          t.whatsapp_templates.forEach((w) => { w.status = 'APPROVED' })
        }
      },
    })
    const r = await installFollowupPack(db, args({ packKey: 'trial_done' }))
    expect(r).toMatchObject({ ok: true, created: true })
    expect(publishSequence).toHaveBeenCalledTimes(1)
    expect(publishSequence.mock.calls[0][1]).toEqual({ sequenceId: tables.email_sequences[0].id })
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(r.followup.state).toBe('live')
  })

  it('submit-time APPROVED is not trusted: a template no longer approved holds it', async () => {
    // Submit answered APPROVED, but by the re-read Meta has rejected it.
    submitsOk('APPROVED')
    const { db, tables } = fakeDb({}, {
      afterOp: (q, t) => {
        if (q.table === 'pipeline_stage_followups' && q.op === 'insert') t.whatsapp_templates[0].status = 'REJECTED'
      },
    })
    const r = await installFollowupPack(db, args())
    expect(r.ok).toBe(true)
    expect(publishSequence).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('the re-read is scoped to this studio', async () => {
    submitsOk('PENDING')
    const { db } = fakeDb({}, {
      afterOp: (q, t) => {
        if (q.table === 'pipeline_stage_followups' && q.op === 'insert') t.whatsapp_templates.forEach((w) => { w.location_id = OTHER_LOC; w.status = 'APPROVED' })
      },
    })
    const r = await installFollowupPack(db, args())
    expect(r.ok).toBe(true)
    expect(publishSequence).not.toHaveBeenCalled()
  })

  it('a failed re-read publishes nothing and says so', async () => {
    submitsOk('APPROVED')
    const { db, tables } = fakeDb({}, {
      failWhen: (q) => (q.table === 'whatsapp_templates' && q.op === 'select' ? { message: 'db down' } : null),
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true })
    expect(r.publishError).toMatch(/Install it again/)
    expect(publishSequence).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('reinstallRecoversStrandedFollowup', async () => {
    // An earlier install linked with stale PENDING statuses (or its publish
    // failed after the claim): the row waits though every template is now
    // approved. Installing again re-checks and publishes.
    const seed = () => ({
      pipeline_stage_followups: [{
        id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: 'seq-1',
        whatsapp_template_id: 'wt-a', pack_key: 'trial_done', state: 'awaiting_approval', want_live: true,
      }],
      email_sequences: [{ id: 'seq-1', location_id: LOC, status: 'draft', graph: null, draft_graph: { nodes: [
        { id: 'n1', type: 'whatsapp', config: { template_id: 'wt-a' } },
        { id: 'n2', type: 'whatsapp', config: { template_id: 'wt-b' } },
      ] } }],
    })
    submitsOk()
    // Still one pending: nothing happens, the row comes back as it was.
    const pending = fakeDb({ ...seed(), whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'APPROVED' }, { id: 'wt-b', location_id: LOC, status: 'PENDING' }] })
    const r0 = await installFollowupPack(pending.db, args({ packKey: 'trial_done' }))
    expect(r0).toMatchObject({ ok: true, created: false, followup: { id: 'fu-1', state: 'awaiting_approval' } })
    expect(publishSequence).not.toHaveBeenCalled()

    // wt-b APPROVED only at another studio does not count.
    const cross = fakeDb({ ...seed(), whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'APPROVED' }, { id: 'wt-b', location_id: OTHER_LOC, status: 'APPROVED' }] })
    await installFollowupPack(cross.db, args({ packKey: 'trial_done' }))
    expect(publishSequence).not.toHaveBeenCalled()

    // Both approved here: it publishes the SAME sequence, submits nothing.
    const { db, tables } = fakeDb({ ...seed(), whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'APPROVED' }, { id: 'wt-b', location_id: LOC, status: 'APPROVED' }] })
    const r = await installFollowupPack(db, args({ packKey: 'trial_done' }))
    expect(r).toMatchObject({ ok: true, created: false, followup: { id: 'fu-1', state: 'live' } })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(publishSequence).toHaveBeenCalledTimes(1)
    expect(publishSequence.mock.calls[0][1]).toEqual({ sequenceId: 'seq-1' })
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(tables.email_sequences).toHaveLength(1)
  })

  it('a waiting row that does not want to go live is not published by a reinstall', async () => {
    submitsOk()
    const { db } = fakeDb({
      pipeline_stage_followups: [{
        id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: 'seq-1',
        whatsapp_template_id: 'wt-a', pack_key: 'book_first_class', state: 'awaiting_approval', want_live: false,
      }],
      email_sequences: [{ id: 'seq-1', location_id: LOC, status: 'draft', draft_graph: { nodes: [{ id: 'n1', type: 'whatsapp', config: { template_id: 'wt-a' } }] } }],
      whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'APPROVED' }],
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: false, followup: { state: 'awaiting_approval' } })
    expect(publishSequence).not.toHaveBeenCalled()
  })

  it('revertFailureReportsStuckLive', async () => {
    submitsOk('APPROVED')
    publishSequence.mockResolvedValue({ ok: false, status: 422, error: 'Flow has problems' })
    const { db, tables } = fakeDb({}, {
      failWhen: (q) => (q.table === 'pipeline_stage_followups' && q.op === 'update' && q.payload?.state === 'awaiting_approval'
        ? { message: 'db down' } : null),
    })
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true, code: 'publish_failed_state_stuck', publishError: 'Flow has problems' })
    // What is on disk, not a stale awaiting_approval.
    expect(r.followup.state).toBe('live')
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    expect(tables.email_sequences[0].status).toBe('draft')
  })

  it('a publish that throws is reverted like a failed one', async () => {
    submitsOk('APPROVED')
    publishSequence.mockRejectedValue(new Error('boom'))
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: true, publishError: 'boom' })
    expect(tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('reinstallRepairsStuckLive', async () => {
    const seed = (seqStatus) => ({
      pipeline_stage_followups: [{
        id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: 'seq-1',
        whatsapp_template_id: 'wt-a', pack_key: 'book_first_class', state: 'live', want_live: true,
      }],
      email_sequences: [{ id: 'seq-1', location_id: LOC, status: seqStatus, graph: null, draft_graph: { nodes: [{ id: 'n1', type: 'whatsapp', config: { template_id: 'wt-a' } }] } }],
      whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'APPROVED' }],
    })
    submitsOk()

    // A genuinely live follow-up (sequence active) is returned untouched.
    const healthy = fakeDb(seed('active'))
    const r0 = await installFollowupPack(healthy.db, args())
    expect(r0).toMatchObject({ ok: true, created: false, followup: { state: 'live' } })
    expect(publishSequence).not.toHaveBeenCalled()
    expect(healthy.ops.filter((q) => q.op === 'update')).toHaveLength(0)

    // Live over a draft sequence: put back, re-checked, published.
    const { db, tables, ops } = fakeDb(seed('draft'))
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: true, created: false, followup: { id: 'fu-1', state: 'live' } })
    expect(publishSequence).toHaveBeenCalledTimes(1)
    expect(publishSequence.mock.calls[0][1]).toEqual({ sequenceId: 'seq-1' })
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.pipeline_stage_followups[0].state).toBe('live')
    const states = ops.filter((q) => q.table === 'pipeline_stage_followups' && q.op === 'update').map((q) => q.payload.state)
    expect(states).toEqual(['awaiting_approval', 'live'])

    // Templates no longer all approved: it is left waiting, not live.
    const held = fakeDb({ ...seed('draft'), whatsapp_templates: [{ id: 'wt-a', location_id: LOC, status: 'PAUSED' }] })
    const r2 = await installFollowupPack(held.db, args())
    expect(r2).toMatchObject({ ok: true, created: false, followup: { state: 'awaiting_approval' } })
    expect(held.tables.pipeline_stage_followups[0].state).toBe('awaiting_approval')
  })

  it('refusesReinstallOverActiveOff', async () => {
    submitsOk()
    const seed = (seqStatus) => ({
      pipeline_stage_followups: [{
        id: 'fu-1', location_id: LOC, pipeline_id: PIPE, stage_id: STAGE, sequence_id: 'seq-old',
        whatsapp_template_id: 'wt-old', pack_key: 'book_first_class', state: 'off', want_live: true,
      }],
      email_sequences: [{ id: 'seq-old', location_id: LOC, status: seqStatus }],
    })
    const { db, tables } = fakeDb(seed('active'))
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'old_sequence_active' })
    expect(r.error).toBe('This follow-up is switched off but its old sequence is still running. Pause that sequence first, then install again.')
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
    expect(tables.email_sequences).toHaveLength(1)
    expect(tables.pipeline_stage_followups[0].state).toBe('off')

    // A paused old sequence is not running: the reinstall goes ahead.
    const paused = fakeDb(seed('paused'))
    const r2 = await installFollowupPack(paused.db, args())
    expect(r2).toMatchObject({ ok: true, created: true })
    expect(paused.tables.pipeline_stage_followups[0]).toMatchObject({ id: 'fu-1', state: 'awaiting_approval' })
  })

  it('a submit that throws is a 500 result, with no sequence', async () => {
    submitWhatsappTemplate.mockRejectedValue(new Error('client exploded'))
    const { db, tables } = fakeDb()
    const r = await installFollowupPack(db, args())
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(tables.email_sequences).toHaveLength(0)
    expect(tables.pipeline_stage_followups).toHaveLength(0)
  })

  it('missing fill-ins or duration are a 400 before anything reaches Meta', async () => {
    submitsOk()
    for (const render of [
      { ...args().render, signer: undefined },
      { ...args().render, studioName: '  ' },
      { ...args().render, durationDays: undefined },
    ]) {
      const { db, tables } = fakeDb()
      const r = await installFollowupPack(db, args({ render }))
      expect(r).toMatchObject({ ok: false, status: 400 })
      expect(tables.email_sequences).toHaveLength(0)
    }
    expect(submitWhatsappTemplate).not.toHaveBeenCalled()
  })

  it('does not publish while one of two templates is still pending', async () => {
    submitWhatsappTemplate
      .mockResolvedValueOnce({ ok: true, template: { id: 'wt-1', status: 'APPROVED' } })
      .mockResolvedValueOnce({ ok: true, template: { id: 'wt-2', status: 'PENDING' } })
    const { db, tables } = fakeDb({
      whatsapp_templates: [{ id: 'wt-1', location_id: LOC, status: 'APPROVED' }, { id: 'wt-2', location_id: LOC, status: 'PENDING' }],
    })
    const r = await installFollowupPack(db, args({ packKey: 'trial_done' }))
    expect(r.ok).toBe(true)
    expect(publishSequence).not.toHaveBeenCalled()
    expect(waIdsOf(tables.email_sequences[0].draft_graph).sort()).toEqual(['wt-1', 'wt-2'])
  })
})
