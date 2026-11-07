import { describe, it, expect } from 'vitest'
import { loadStageCoverage } from './pipeline-stage-coverage'

// A table-keyed fake: every chained builder method returns the builder, and
// awaiting it yields the table's canned { data, error }.
function fakeDb(tables) {
  const seen = []
  return {
    seen,
    from(table) {
      const filters = []
      const q = {
        select: () => q,
        eq: (c, v) => { filters.push(['eq', c, v]); return q },
        in: (c, v) => { filters.push(['in', c, v]); return q },
        order: () => q,
        range: () => q,
        then: (res, rej) => {
          seen.push({ table, filters })
          const t = tables[table] || { data: [] }
          let data = t.data
          const archivedEq = filters.find((f) => f[1] === 'archived')
          if (table === 'pipeline_stages' && archivedEq) data = data.filter((r) => r.archived === archivedEq[2])
          const enabledEq = filters.find((f) => f[1] === 'enabled')
          if (table === 'pipelines' && enabledEq) data = data.filter((r) => r.enabled === enabledEq[2])
          return Promise.resolve({ data: t.error ? null : data, error: t.error || null }).then(res, rej)
        },
      }
      return q
    },
  }
}

const board = { id: 'b1', key: 'main', name: 'Main', display_order: 1, enabled: true }
const stage = (over) => ({ id: 's', pipeline_id: 'b1', slug: 'x', name: 'X', display_order: 1, is_dormant: false, archived: false, ...over })

describe('loadStageCoverage', () => {
  it('groupsFollowupsByStage', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [stage({ id: 's1', slug: 'first_class', name: 'First class' }), stage({ id: 's2', slug: 'cold', name: 'Cold', is_dormant: true })] },
      email_sequences: { data: [
        { id: 'q1', name: 'After first class', trigger_type: 'pipeline_stage_change', trigger_config: { to_status: 'first_class' } },
        { id: 'q2', name: 'Other', trigger_type: 'pipeline_stage_change', trigger_config: { to_status: 'elsewhere' } },
      ] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.ok).toBe(true)
    const [fc, cold] = r.boards[0].stages
    expect(fc.followups).toEqual([{ id: 'q1', name: 'After first class', trigger: 'pipeline_stage_change' }])
    expect(fc.isPile).toBe(false)
    expect(cold.followups).toEqual([])
    expect(cold.isPile).toBe(true)
    expect(db.seen.find((s) => s.table === 'email_sequences').filters).toContainEqual(['eq', 'status', 'active'])
  })

  it('entryTriggersByModuleOnNewRole', async () => {
    const seqs = [
      { id: 'q1', name: 'Welcome', trigger_type: 'contact_created', trigger_config: {} },
      { id: 'q2', name: 'Stillorgan buyer', trigger_type: 'paid_trial_checkout_purchased', trigger_config: {} },
      { id: 'q3', name: 'Hatch buyer', trigger_type: 'un1t_paid_trial_purchased', trigger_config: {} },
    ]
    const run = async (module) => {
      const db = fakeDb({
        pipelines: { data: [{ ...board, module }] },
        pipeline_stages: { data: [stage({ id: 's1', slug: 'paid_trial_new_lead', stage_role: 'new' }), stage({ id: 's2', slug: 'rebook', stage_role: 'custom' })] },
        email_sequences: { data: seqs },
      })
      return (await loadStageCoverage(db, 'loc1')).boards[0].stages
    }
    const [hatchNew, hatchOther] = await run('paid_trial_un1t')
    expect(hatchNew.followups.map((f) => f.trigger)).toEqual(['un1t_paid_trial_purchased'])
    expect(hatchOther.followups).toEqual([])
    const [stillNew] = await run('paid_trial')
    expect(stillNew.followups.map((f) => f.trigger)).toEqual(['paid_trial_checkout_purchased'])
    const [acqNew] = await run('acquisition')
    expect(acqNew.followups.map((f) => f.trigger)).toEqual(['contact_created'])
  })

  it('offerBoardCoverage', async () => {
    const db = fakeDb({
      pipelines: { data: [{ ...board, key: 'summer', name: 'Summer offer', module: 'offer' }] },
      pipeline_stages: { data: [
        stage({ id: 's1', slug: 'new', name: 'Joined', stage_role: 'new' }),
        stage({ id: 's2', slug: 'bought', name: 'Bought', stage_role: 'converted' }),
      ] },
      email_sequences: { data: [
        { id: 'q1', name: 'Bought thanks', trigger_type: 'pipeline_stage_change', trigger_config: { to_status: 'bought' } },
      ] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.ok).toBe(true)
    const [fresh, bought] = r.boards[0].stages
    expect(bought.followups).toEqual([{ id: 'q1', name: 'Bought thanks', trigger: 'pipeline_stage_change' }])
    expect(fresh.followups).toEqual([])   // an entry with no follow-up aimed at it is not falsely covered
  })

  it('pileFromRole', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [
        stage({ id: 's1', slug: 'a', stage_role: 'pile', is_dormant: false }),
        stage({ id: 's2', slug: 'b', stage_role: 'custom', is_dormant: true }),
        stage({ id: 's3', slug: 'c', stage_role: undefined, is_dormant: true }),
      ] },
      email_sequences: { data: [] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.boards[0].stages.map((s) => s.isPile)).toEqual([true, false, true])
  })

  it('skipsDisabledBoardsAndArchivedStages', async () => {
    const db = fakeDb({
      pipelines: { data: [board, { ...board, id: 'b2', key: 'off', enabled: false }] },
      pipeline_stages: { data: [stage({ id: 's1', slug: 'a' }), stage({ id: 's2', slug: 'gone', archived: true })] },
      email_sequences: { data: [] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.boards.map((b) => b.id)).toEqual(['b1'])
    expect(r.boards[0].stages.map((s) => s.slug)).toEqual(['a'])
  })

  it('returnsNotOkOnReadError', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [] },
      email_sequences: { error: { message: 'boom' } },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r).toEqual({ ok: false, error: 'boom' })
  })

  it('coverageIncludesFollowupStates', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [stage({ id: 's1', slug: 'first_class' }), stage({ id: 's2', slug: 'cold' })] },
      email_sequences: { data: [] },
      pipeline_stage_followups: { data: [
        { stage_id: 's1', pack_key: 'after_first_class', state: 'live', version: 3 },
        { stage_id: 's1', pack_key: 'nudge', state: 'draft', version: 1 },
      ] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    const [fc, cold] = r.boards[0].stages
    expect(fc.followupStates).toEqual([
      { pack_key: 'after_first_class', state: 'live', version: 3 },
      { pack_key: 'nudge', state: 'draft', version: 1 },
    ])
    expect(cold.followupStates).toEqual([])
    expect(db.seen.find((s) => s.table === 'pipeline_stage_followups').filters).toContainEqual(['eq', 'location_id', 'loc1'])
  })

  it('followupReadFailureFailsCoverage', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [stage({ id: 's1' })] },
      email_sequences: { data: [] },
      pipeline_stage_followups: { data: [], error: { message: 'boom' } },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.ok).toBe(false)
  })
})
