// SCHEDULE-CHANGE-LOG.1 — unit tests for the audit/re-notify helpers.
import { describe, it, expect } from 'vitest'
import { logRosterChange, distinctCoachIds, ROSTER_CHANGE_ACTIONS } from './roster-change-log'

function mockDb(captured) {
  return {
    from() {
      return {
        insert(row) {
          captured.push(row)
          return Promise.resolve({ error: null })
        },
      }
    },
  }
}

describe('distinctCoachIds', () => {
  it('dedupes and drops falsy ids', () => {
    expect(distinctCoachIds([{ coach_id: 'a' }, { coach_id: 'b' }, { coach_id: 'a' }, { coach_id: null }, {}]))
      .toEqual(['a', 'b'])
  })
  it('handles empty / null', () => {
    expect(distinctCoachIds([])).toEqual([])
    expect(distinctCoachIds(null)).toEqual([])
  })
})

describe('ROSTER_CHANGE_ACTIONS', () => {
  it('matches the DB CHECK constraint values', () => {
    expect(ROSTER_CHANGE_ACTIONS).toEqual(['assigned', 'unassigned', 'time_changed'])
  })
})

describe('logRosterChange', () => {
  const base = { isPublished: true, locationId: 'loc1', coachId: 'coach1', action: 'assigned', actorId: 'mgr1', blockId: 'blk1', blockDate: '2026-06-06' }

  it('logs a post-publish edit', async () => {
    const captured = []
    const r = await logRosterChange(mockDb(captured), base)
    expect(r).toEqual({ logged: true })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ location_id: 'loc1', coach_id: 'coach1', action: 'assigned', actor_id: 'mgr1', block_id: 'blk1', block_date: '2026-06-06' })
  })

  it('does NOT log a draft edit (block roster not published)', async () => {
    const captured = []
    const r = await logRosterChange(mockDb(captured), { ...base, isPublished: false })
    expect(r).toEqual({ logged: false, reason: 'not_published' })
    expect(captured).toHaveLength(0)
  })

  it('rejects an invalid action', async () => {
    const captured = []
    const r = await logRosterChange(mockDb(captured), { ...base, action: 'frobnicated' })
    expect(r.logged).toBe(false)
    expect(r.reason).toBe('bad_action')
    expect(captured).toHaveLength(0)
  })

  it('requires locationId + coachId', async () => {
    const captured = []
    expect((await logRosterChange(mockDb(captured), { ...base, coachId: null })).reason).toBe('missing')
    expect((await logRosterChange(mockDb(captured), { ...base, locationId: null })).reason).toBe('missing')
    expect(captured).toHaveLength(0)
  })

  it('never throws — swallows a DB error', async () => {
    const throwingDb = { from() { return { insert() { throw new Error('boom') } } } }
    const r = await logRosterChange(throwingDb, base)
    expect(r).toEqual({ logged: false, reason: 'error' })
  })
})
