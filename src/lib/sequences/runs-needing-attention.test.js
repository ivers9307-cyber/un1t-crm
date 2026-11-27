import { describe, it, expect } from 'vitest'
import { loadRunsNeedingAttention } from './runs-needing-attention'

const NOW = new Date('2026-11-26T12:00:00Z')

// Thenable builder: each from() call returns the next canned result and
// records the filters it was given.
function fakeDb(results) {
  const calls = []
  let i = 0
  return {
    calls,
    from() {
      const r = results[i++]
      const c = { filters: [] }
      calls.push(c)
      const b = {
        select: () => b, limit: () => b,
        in: (...a) => { c.filters.push(['in', ...a]); return b },
        eq: (...a) => { c.filters.push(['eq', ...a]); return b },
        lt: (...a) => { c.filters.push(['lt', ...a]); return b },
        gte: (...a) => { c.filters.push(['gte', ...a]); return b },
        not: (...a) => { c.filters.push(['not', ...a]); return b },
        then: (res) => res(r),
      }
      return b
    },
  }
}

const SEQS = [{ id: 's1', name: 'Welcome' }, { id: 's2', name: 'Win-back' }]

describe('loadRunsNeedingAttention (STUCKRUNS.1)', () => {
  it('counts overdue active runs and runs stopped on an error, per automation', async () => {
    const db = fakeDb([
      { data: [{ sequence_id: 's1' }, { sequence_id: 's1' }], error: null },
      { data: [
        { sequence_id: 's2', exit_reason: 'undeliverable', last_error: 'inactive recipient' },
        { sequence_id: 's2', exit_reason: null, last_error: 'boom' },
        { sequence_id: 's2', exit_reason: 'goal_met', last_error: 'invoice_paid' },
      ], error: null },
    ])
    const r = await loadRunsNeedingAttention(db, SEQS, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([
      { sequence_id: 's1', name: 'Welcome', overdue: 2, stopped: 0, sample_error: null },
      { sequence_id: 's2', name: 'Win-back', overdue: 0, stopped: 2, sample_error: 'inactive recipient' },
    ])
    expect(db.calls[0].filters).toContainEqual(['lt', 'next_step_at', '2026-11-26T10:00:00.000Z'])
    expect(db.calls[1].filters).toContainEqual(['gte', 'last_processed_at', '2026-10-27T12:00:00.000Z'])
  })

  it('reads nothing when the studio has no automations', async () => {
    const db = fakeDb([])
    expect(await loadRunsNeedingAttention(db, [], { now: NOW })).toEqual({ ok: true, rows: [] })
    expect(db.calls).toHaveLength(0)
  })

  it('reports not ok, with no rows, when a read fails', async () => {
    const db = fakeDb([{ data: null, error: { message: 'x' } }, { data: [], error: null }])
    expect(await loadRunsNeedingAttention(db, SEQS, { now: NOW })).toEqual({ ok: false, rows: [] })
  })
})

describe('maskEmails (STUCKMASK.1)', () => {
  it('hides every address in a Postmark error and keeps the rest', async () => {
    const { maskEmails } = await import('./runs-needing-attention.js')
    expect(maskEmails('Found inactive addresses: a.b+x@example.com, C@Mail.IE.'))
      .toBe('Found inactive addresses: [email hidden], [email hidden].')
    expect(maskEmails('boom')).toBe('boom')
  })
})
