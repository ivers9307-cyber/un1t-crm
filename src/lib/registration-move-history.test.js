import { describe, it, expect } from 'vitest'
import { loadMoveHistory } from './registration-move-history.js'

function fakeDb({ movesIn = [], movesOut = [], inError = null, outError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.then = (res, rej) => {
        const isOut = q.ops.some((o) => o[0] === 'eq' && o[1] === 'from_event_id')
        const v = isOut ? { data: outError ? null : movesOut, error: outError } : { data: inError ? null : movesIn, error: inError }
        return Promise.resolve(v).then(res, rej)
      }
      return b
    },
  }
}
const mv = (over) => ({ id: 'm1', registration_id: 'r1', created_at: '2026-10-08T10:00:00Z', actor_name: 'Richard', price_gap_cents: 0, forced: false, notified_at: null, from_event: { id: 'e1', name: 'A', race_date: '2026-10-18' }, ...over })

describe('loadMoveHistory', () => {
  it('keeps the newest move in per entry, only for entries on the list', async () => {
    const db = fakeDb({ movesIn: [mv({ id: 'new', created_at: '2026-10-09T00:00:00Z' }), mv({ id: 'old' }), mv({ id: 'gone', registration_id: 'r9' })] })
    const { lastMoveByReg } = await loadMoveHistory(db, { eventId: 'e2', regIds: ['r1'] })
    expect(lastMoveByReg.r1.id).toBe('new')
    expect(lastMoveByReg.r9).toBeUndefined()
  })
  it('labels moves out and caps at 200, newest first', async () => {
    const db = fakeDb({ movesOut: [{ id: 'o1', created_at: '2026-10-08T10:00:00Z', actor_name: '', registration: { teams: { name: 'Wolves', size: 2, team_members: [{}, {}] } }, to_event: { id: 'e5', name: 'B', race_date: '2026-11-01' } }] })
    const { movedOut } = await loadMoveHistory(db, { eventId: 'e1', regIds: [] })
    expect(movedOut).toEqual([{ id: 'o1', created_at: '2026-10-08T10:00:00Z', actor_name: '', label: 'Wolves', to_event: { id: 'e5', name: 'B', race_date: '2026-11-01' } }])
    const out = db.calls.find((q) => q.ops.some((o) => o[0] === 'eq' && o[1] === 'from_event_id'))
    expect(out.ops).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(out.ops).toContainEqual(['limit', 200])
  })
  it('the moves-in read carries how the gap was settled (EVENT-MOVE.3)', async () => {
    const db = fakeDb({ movesIn: [mv({ price_gap_cents: 1000, gap_settled_at: '2026-10-09T10:00:00Z', gap_settled_how: 'waived', gap_settled_by_name: 'Richard' })] })
    const { lastMoveByReg } = await loadMoveHistory(db, { eventId: 'e2', regIds: ['r1'] })
    const movesIn = db.calls.find((q) => q.ops.some((o) => o[0] === 'eq' && o[1] === 'to_event_id'))
    const cols = movesIn.ops.find((o) => o[0] === 'select')[1].split(',').map((c) => c.trim())
    expect(cols).toEqual(expect.arrayContaining(['gap_settled_at', 'gap_settled_how', 'gap_settled_by_name']))
    expect(lastMoveByReg.r1).toMatchObject({ gap_settled_how: 'waived', gap_settled_by_name: 'Richard' })
  })
  it('skips the moves-in read when there are no entries', async () => {
    const db = fakeDb()
    const { lastMoveByReg } = await loadMoveHistory(db, { eventId: 'e1', regIds: [] })
    expect(lastMoveByReg).toEqual({})
    expect(db.calls.filter((q) => q.ops.some((o) => o[0] === 'eq' && o[1] === 'to_event_id'))).toHaveLength(0)
  })
  it('degrades on a read error and never throws', async () => {
    const db = fakeDb({ inError: { message: 'boom' }, outError: { message: 'boom' } })
    const r = await loadMoveHistory(db, { eventId: 'e1', regIds: ['r1'] })
    expect(r).toEqual({ lastMoveByReg: {}, movedOut: [] })
  })
})
