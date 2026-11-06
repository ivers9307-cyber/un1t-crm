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
          const t = tables[table]
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

  it('countsEntryTriggerForNewLead', async () => {
    const db = fakeDb({
      pipelines: { data: [board] },
      pipeline_stages: { data: [stage({ id: 's1', slug: 'new_lead', name: 'New lead' }), stage({ id: 's2', slug: 'rebook', name: 'Rebook' })] },
      email_sequences: { data: [{ id: 'q1', name: 'Welcome', trigger_type: 'contact_created', trigger_config: {} }] },
    })
    const r = await loadStageCoverage(db, 'loc1')
    expect(r.boards[0].stages[0].followups).toEqual([{ id: 'q1', name: 'Welcome', trigger: 'contact_created' }])
    expect(r.boards[0].stages[1].followups).toEqual([])
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
})
