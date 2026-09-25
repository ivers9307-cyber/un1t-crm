// SCHEDULE-CHANGE-LOG.1 — unit tests for the audit/re-notify helpers.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))

import { logWarn } from './log'
import {
  logRosterChange,
  distinctCoachIds,
  ROSTER_CHANGE_ACTIONS,
  collectUnnotifiedChanges,
  markChangesNotified,
  listRosterChanges,
  shapeRosterChange,
  ROSTER_CHANGE_LOG_MAX_ROWS,
  logBlockEdit,
  BLOCK_EDITED_ACTION,
} from './roster-change-log'

function mockDb(captured, { insertResult = { data: { id: 'log-1' }, error: null } } = {}) {
  return {
    from() {
      return {
        insert(row) {
          captured.push(row)
          return {
            select() {
              return {
                single() {
                  return Promise.resolve(insertResult)
                },
              }
            },
          }
        },
      }
    },
  }
}

beforeEach(() => {
  logWarn.mockClear()
})

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

  it('logs a post-publish edit and returns the inserted id', async () => {
    const captured = []
    const r = await logRosterChange(mockDb(captured), base)
    expect(r).toEqual({ logged: true, id: 'log-1' })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ location_id: 'loc1', coach_id: 'coach1', action: 'assigned', actor_id: 'mgr1', block_id: 'blk1', block_date: '2026-06-06' })
  })

  it('an insert error returns logged:false and logs a warning (does not throw)', async () => {
    const captured = []
    const db = mockDb(captured, { insertResult: { data: null, error: { message: 'insert blew up' } } })
    const r = await logRosterChange(db, base)
    expect(r).toEqual({ logged: false, reason: 'error' })
    expect(logWarn).toHaveBeenCalledWith('roster-change-log', 'insert failed', { err: 'insert blew up' })
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

// NOTIFY.1 review follow-up — collectUnnotifiedChanges/markChangesNotified used
// to discard a RESOLVED { error } (PostgREST resolves, it doesn't throw), so a
// failed select/update looked identical to "no rows" and left no trace. Both
// must now log and behave exactly as the empty/no-op case.
describe('collectUnnotifiedChanges — resolved error', () => {
  const range = { locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-07' }

  function queryDb(result) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      is: () => Promise.resolve(result),
    }
    return { from: () => chain }
  }

  it('logs and returns [] on a resolved { error }', async () => {
    const db = queryDb({ data: null, error: { message: 'connection reset' } })
    const rows = await collectUnnotifiedChanges(db, range)
    expect(rows).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('roster-change-log', 'collect failed', { err: 'connection reset' })
  })
})

describe('markChangesNotified — resolved error', () => {
  function updateDb(result) {
    return {
      from: () => ({
        update: () => ({
          in: () => Promise.resolve(result),
        }),
      }),
    }
  }

  it('logs on a resolved { error } and never throws', async () => {
    const db = updateDb({ data: null, error: { message: 'deadlock detected' } })
    await expect(markChangesNotified(db, ['ch1'])).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith('roster-change-log', 'mark notified failed', { err: 'deadlock detected' })
  })
})

// CHANGELOG.1 — the human-facing read.

// A raw row as PostgREST returns it for the select in listRosterChanges.
const raw = (i, over = {}) => ({
  id: `c${String(i).padStart(5, '0')}`, block_id: 'b1', block_date: '2026-09-15', coach_id: 'p1', actor_id: 'm1',
  action: 'assigned', details: { via: 'copy_week' },
  notified_at: null, created_at: '2026-09-15T12:58:00Z',
  actor: { id: 'm1', full_name: 'Manager B' },
  coach: { id: 'p1', full_name: 'Coach A' },
  shift_blocks: { start_time: '06:00:00', end_time: '07:00:00', shift_templates: { name: 'Morning' } },
  ...over,
})

function pagedDb(total, { failOnPage = null } = {}) {
  const calls = []
  const all = Array.from({ length: total }, (_, i) => raw(i))
  return {
    calls,
    from(table) {
      expect(table).toBe('roster_change_log')
      const q = { filters: [], orders: [] }
      const chain = {
        select: (s) => { q.select = s; return chain },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return chain },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return chain },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return chain },
        order: (c, o) => { q.orders.push([c, o?.ascending]); return chain },
        range: (from, to) => {
          q.range = [from, to]
          calls.push(q)
          if (failOnPage !== null && calls.length - 1 === failOnPage) return Promise.resolve({ data: null, error: { message: 'boom' } })
          return Promise.resolve({ data: all.slice(from, to + 1), error: null })
        },
      }
      return chain
    },
  }
}

describe('shapeRosterChange', () => {
  it('flattens the embeds to exactly the fields the drawer needs, and nothing else', () => {
    // toEqual: no id of a block or a person crosses the wire, only what prints.
    expect(shapeRosterChange(raw(1))).toEqual({
      id: 'c00001', action: 'assigned', block_date: '2026-09-15',
      start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning',
      coach_name: 'Coach A', actor_name: 'Manager B', self_change: false,
      details: { via: 'copy_week' }, notified_at: null, created_at: '2026-09-15T12:58:00Z',
    })
  })

  it('self_change: the coach made the change themselves (stamped, nobody to tell)', () => {
    expect(shapeRosterChange(raw(1, { actor_id: 'p1' })).self_change).toBe(true)
    // Two SET NULL ids are not "the same person".
    expect(shapeRosterChange(raw(1, { actor_id: null, coach_id: null })).self_change).toBe(false)
  })

  it('a deleted slot (block_id SET NULL) and deleted profiles become nulls, not a crash', () => {
    expect(shapeRosterChange(raw(1, { block_id: null, shift_blocks: null, actor: null, coach: null, coach_id: null, details: null })))
      .toMatchObject({ start_time: null, end_time: null, shift_name: null, coach_name: null, actor_name: null, self_change: false, details: {} })
  })
})

describe('shapeRosterChange — details whitelist', () => {
  // `details` is free-form jsonb any writer can extend. Only the keys the
  // formatter prints cross the wire, so a future writer cannot leak a field
  // (a note, a rate) through this read by accident.
  it('passes on only the keys the drawer prints, and only times inside from/to', () => {
    const shaped = shapeRosterChange(raw(1, { details: {
      via: 'swap', swap_id: 's1', effect: 'approved_reassign', roster_status: 'published', note: 'private',
      source: 'template_edit', template_id: 't1',
      start_time_override: null, end_time_override: '07:30:00',
      from: { start_time: '06:00:00', end_time: '07:00:00', hourly_rate: 1 },
      to: { start_time: '06:30:00', end_time: '07:30:00' },
    } }))
    expect(shaped.details).toEqual({
      via: 'swap', source: 'template_edit', roster_status: 'published',
      start_time_override: null, end_time_override: '07:30:00',
      from: { start_time: '06:00:00', end_time: '07:00:00' },
      to: { start_time: '06:30:00', end_time: '07:30:00' },
    })
  })

  it('keeps a null override KEY: "both cleared" is how the formatter knows a reset', () => {
    expect(shapeRosterChange(raw(1, { details: { start_time_override: null, end_time_override: null } })).details)
      .toEqual({ start_time_override: null, end_time_override: null })
  })

  it('whitelists VALUES too: an object or an oversized string under a known key does not pass', () => {
    const d = shapeRosterChange(raw(1, { details: {
      via: { rate: 50 }, source: 'x'.repeat(41),
      start_time_override: { rate: 50 }, end_time_override: '7am',
      from: { start_time: 'DROP TABLE', end_time: 50 }, to: { start_time: '06:30:00', end_time: '25:99' },
    } })).details
    expect(d).toEqual({
      from: { start_time: null, end_time: null },
      to: { start_time: '06:30:00', end_time: null },
    })
    expect(JSON.stringify(d)).not.toMatch(/rate|DROP/)
  })

  it('HH:MM and HH:MM:SS are both times', () => {
    expect(shapeRosterChange(raw(1, { details: { start_time_override: '06:30', end_time_override: '07:30:00' } })).details)
      .toEqual({ start_time_override: '06:30', end_time_override: '07:30:00' })
  })

  it('reason passes by KNOWN VALUE only', () => {
    expect(shapeRosterChange(raw(1, { details: { reason: 'staff_permanent_delete' } })).details).toEqual({ reason: 'staff_permanent_delete' })
    expect(shapeRosterChange(raw(1, { details: { reason: 'they were let go for misconduct' } })).details).toEqual({})
    expect(shapeRosterChange(raw(1, { details: { reason: { note: 'x' } } })).details).toEqual({})
  })

  it('roster_status passes by known value, and keeps its KEY when unreadable (a draft, to the reader)', () => {
    expect(shapeRosterChange(raw(1, { details: { via: 'swap_drop', roster_status: 'draft' } })).details).toEqual({ via: 'swap_drop', roster_status: 'draft' })
    expect(shapeRosterChange(raw(1, { details: { via: 'swap_drop', roster_status: null } })).details).toEqual({ via: 'swap_drop', roster_status: null })
    expect(shapeRosterChange(raw(1, { details: { via: 'swap_drop', roster_status: { x: 1 } } })).details).toEqual({ via: 'swap_drop', roster_status: null })
  })

  it('a non-object details is an empty one', () => {
    expect(shapeRosterChange(raw(1, { details: 'oops' })).details).toEqual({})
    expect(shapeRosterChange(raw(1, { details: { from: 'oops' } })).details).toEqual({})
  })
})

describe('listRosterChanges', () => {
  it('reads ONE studio\'s changes whose shift date is in the range, newest first', async () => {
    const db = pagedDb(3)
    const { changes, truncated, error } = await listRosterChanges(db, { locationId: 'loc1', from: '2026-09-14', to: '2026-09-20' })
    expect(error).toBeNull()
    expect(truncated).toBe(false)
    expect(changes).toHaveLength(3)
    expect(changes[0]).toMatchObject({ coach_name: 'Coach A', actor_name: 'Manager B', shift_name: 'Morning' })
    expect(db.calls[0].filters).toEqual([
      ['eq', 'location_id', 'loc1'], ['gte', 'block_date', '2026-09-14'], ['lte', 'block_date', '2026-09-20'],
    ])
    // A TOTAL order, or pages can repeat or skip rows that share a created_at.
    expect(db.calls[0].orders).toEqual([['created_at', false], ['id', false]])
  })

  it('names both profile foreign keys, or PostgREST answers 300 PGRST201', async () => {
    const db = pagedDb(1)
    await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(db.calls[0].select).toContain('actor:profiles!actor_id(')
    expect(db.calls[0].select).toContain('coach:profiles!coach_id(')
  })

  it('selects no pay field', async () => {
    const db = pagedDb(1)
    await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(db.calls[0].select).not.toMatch(/hourly_rate|annual_salary|overtime_rate|contracted_hours/)
  })

  it('pages past the 1,000-row cap', async () => {
    const db = pagedDb(2300)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(2300)
    expect(truncated).toBe(false)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops at the ceiling and SAYS it stopped', async () => {
    const db = pagedDb(ROSTER_CHANGE_LOG_MAX_ROWS + 2500)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS)
    expect(truncated).toBe(true)
    // One page past the ceiling is read to learn that, and no more.
    expect(db.calls).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS / 1000 + 1)
  })

  it('exactly the ceiling is NOT truncated', async () => {
    const db = pagedDb(ROSTER_CHANGE_LOG_MAX_ROWS)
    const { changes, truncated } = await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' })
    expect(changes).toHaveLength(ROSTER_CHANGE_LOG_MAX_ROWS)
    expect(truncated).toBe(false)
  })

  it('returns the error and NO partial rows: a failed read must not look like a quiet week', async () => {
    const db = pagedDb(1500, { failOnPage: 1 })
    expect(await listRosterChanges(db, { locationId: 'loc1', from: 'a', to: 'b' }))
      .toEqual({ changes: [], truncated: false, error: { message: 'boom' } })
  })

  it('refuses to run unscoped', async () => {
    const db = pagedDb(5)
    const res = await listRosterChanges(db, { locationId: '', from: 'a', to: 'b' })
    expect(res.error?.message).toMatch(/locationId, from and to are required/)
    expect(db.calls).toHaveLength(0)
  })
})
// BLOCKEDIT.1 — one coachless row per edit of a published block, born stamped.
describe('logBlockEdit', () => {
  it('writes one coachless block_edited row, stamped at insert', async () => {
    const captured = []
    const res = await logBlockEdit(mockDb(captured), {
      isPublished: true, locationId: 'loc-1', blockId: 'b1', blockDate: '2026-09-30', actorId: 'mgr',
      details: { source: 'block_edit', min_coaches: { from: 1, to: 2 } },
    })
    expect(res).toEqual({ logged: true, id: 'log-1' })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-30', actor_id: 'mgr',
      coach_id: null, action: BLOCK_EDITED_ACTION,
      details: { source: 'block_edit', min_coaches: { from: 1, to: 2 } },
    })
    expect(Number.isFinite(Date.parse(captured[0].notified_at))).toBe(true)
  })

  it('a draft block is not logged (drafts ride the first publish)', async () => {
    const captured = []
    expect(await logBlockEdit(mockDb(captured), { isPublished: false, locationId: 'loc-1', blockId: 'b1' }))
      .toEqual({ logged: false, reason: 'not_published' })
    expect(captured).toEqual([])
  })

  it('never throws: a failed insert is logged and reported', async () => {
    const res = await logBlockEdit(mockDb([], { insertResult: { data: null, error: { message: 'boom' } } }), {
      isPublished: true, locationId: 'loc-1', blockId: 'b1',
    })
    expect(res).toEqual({ logged: false, reason: 'error' })
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('shapeRosterChange — BLOCKEDIT.1 details', () => {
  const raw = (details, over = {}) => ({
    id: 'r1', action: 'block_edited', block_id: 'b1', block_date: '2026-09-30', actor_id: 'm', coach_id: null,
    details, notified_at: '2026-09-29T10:00:00Z', created_at: '2026-09-29T10:00:00Z',
    shift_blocks: { start_time: '10:00:00', end_time: '13:00:00', shift_templates: { name: 'Morning' } },
    coach: null, actor: { full_name: 'Manager B' }, ...over,
  })

  it('passes min/max as integer pairs, the briefing change by known value, and never free text', () => {
    const out = shapeRosterChange(raw({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      max_coaches: { from: 3, to: 'lots' },
      briefing: 'added',
      briefing_text: 'Fire drill at 10',
    }))
    expect(out.details).toEqual({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      max_coaches: { from: 3, to: null },
      briefing: 'added',
    })
    expect(JSON.stringify(out)).not.toMatch(/Fire drill/)
  })

  it('drops an unknown briefing value and keeps a known notice', () => {
    expect(shapeRosterChange(raw({ briefing: 'Bring bands' })).details).toEqual({})
    expect(shapeRosterChange(raw({ notice: 'not_needed' })).details).toEqual({ notice: 'not_needed' })
    expect(shapeRosterChange(raw({ notice: 'whatever' })).details).toEqual({})
  })
})
