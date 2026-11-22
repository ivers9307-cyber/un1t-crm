// USUALCOACH.1 — the save rule and the fill. createFakeDb is not used: it is
// checked against supabase/schema/snapshot.json, which is captured from the
// live database and will only carry usual_coach_ids once mig 869 is applied.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('./candidates-data', () => ({ readEligibleMembers: vi.fn(), loadBlockCandidates: vi.fn() }))

import {
  checkUsualCoaches, fillUsualCoaches, readBlocksForFill, normaliseUsualCoachIds,
  usualCoachRefusal, MAX_USUAL_COACHES,
} from './shift-usual-coaches'
import { readEligibleMembers, loadBlockCandidates } from './candidates-data'
import { logWarn } from './log'

const A = 'a0000000-0000-0000-0000-00000000000a'
const B = 'b0000000-0000-0000-0000-00000000000b'
const C = 'c0000000-0000-0000-0000-00000000000c'
const ALL_CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true }

const block = (over = {}) => ({
  id: 'blk-1', location_id: 'loc-1', template_id: 'tpl-1', block_date: '2026-12-07',
  start_time: '09:00:00', end_time: '10:00:00', max_coaches: 3, roster_id: null, rosters: null,
  shift_templates: { name: 'Morning', start_time: '09:00:00', end_time: '10:00:00', active: true, usual_coach_ids: [A, B] },
  shift_assignments: [], locations: { timezone: 'Europe/Dublin' },
  ...over,
})
const cand = (id, over = {}) => ({ profile_id: id, free: true, on_leave: null, unavailable: null, ...over })

// Records every insert; `insertErrors` maps profile_id -> error.
function fakeDb({ insertErrors = {}, selectResult = { data: [], error: null } } = {}) {
  const inserts = []
  const selects = []
  const db = {
    inserts, selects,
    from(table) {
      if (table === 'shift_assignments') {
        return {
          insert(row) {
            inserts.push(row)
            const err = insertErrors[row.profile_id]
            return { select: () => ({ single: async () => (err ? { data: null, error: err } : { data: { id: `asg-${inserts.length}` }, error: null }) }) }
          },
        }
      }
      const q = {
        calls: [],
        select(s) { q.calls.push(['select', s]); return q },
        in(...a) { q.calls.push(['in', ...a]); return q },
        eq(...a) { q.calls.push(['eq', ...a]); return q },
        gte(...a) { q.calls.push(['gte', ...a]); return q },
        lte(...a) { q.calls.push(['lte', ...a]); return q },
        order(...a) { q.calls.push(['order', ...a]); return q },
        range(...a) { q.calls.push(['range', ...a]); return q },
        then: (ok, bad) => Promise.resolve(selectResult).then(ok, bad),
      }
      selects.push({ table, q })
      return q
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  loadBlockCandidates.mockResolvedValue({ candidates: [cand(A), cand(B)], checked: ALL_CHECKED, error: null })
})

describe('normaliseUsualCoachIds', () => {
  it('keeps first-seen order and drops blanks and repeats', () => {
    expect(normaliseUsualCoachIds([B, A, B, '', null])).toEqual([B, A])
    expect(normaliseUsualCoachIds(null)).toEqual([])
  })
})

describe('checkUsualCoaches (the save rule)', () => {
  it('accepts active members of the studio and reads only that studio', async () => {
    readEligibleMembers.mockResolvedValue({ members: [{ profile_id: A }, { profile_id: B }], error: null })
    const out = await checkUsualCoaches({}, { locationId: 'loc-1', profileIds: [B, A, B] })
    expect(out).toEqual({ ok: true, ids: [B, A] })
    expect(readEligibleMembers).toHaveBeenCalledWith({}, { locationId: 'loc-1' })
  })

  it('refuses someone who is not active staff at this studio (another studio, deactivated or deleted)', async () => {
    readEligibleMembers.mockResolvedValue({ members: [{ profile_id: A }], error: null })
    const out = await checkUsualCoaches({}, { locationId: 'loc-1', profileIds: [A, C] })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(out.error).toMatch(/not active staff at this studio/)
  })

  it('an empty list needs no read; a failed read refuses', async () => {
    expect(await checkUsualCoaches({}, { locationId: 'loc-1', profileIds: [] })).toEqual({ ok: true, ids: [] })
    expect(readEligibleMembers).not.toHaveBeenCalled()
    readEligibleMembers.mockResolvedValue({ members: null, error: { message: 'down' } })
    expect(await checkUsualCoaches({}, { locationId: 'loc-1', profileIds: [A] })).toMatchObject({ ok: false, status: 500 })
  })

  it('refuses more than the cap', async () => {
    const many = Array.from({ length: MAX_USUAL_COACHES + 1 }, (_, i) => `id-${i}`)
    expect(await checkUsualCoaches({}, { locationId: 'loc-1', profileIds: many })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('usualCoachRefusal', () => {
  it('maps each blocking fact to its reason; advisories do not block', () => {
    expect(usualCoachRefusal(undefined)).toBe('not_at_studio')
    expect(usualCoachRefusal(cand(A, { free: false }))).toBe('clash')
    expect(usualCoachRefusal(cand(A, { on_leave: { label: 'Holiday' } }))).toBe('time_off')
    expect(usualCoachRefusal(cand(A, { unavailable: { summary: 'Cannot work' } }))).toBe('unavailable')
    expect(usualCoachRefusal(cand(A, { rest_gap: { hours: 9 }, week_over: true }))).toBeNull()
  })
})

describe('fillUsualCoaches', () => {
  it('assigns the usual coaches in order, as the actor', async () => {
    const db = fakeDb()
    const out = await fillUsualCoaches(db, [block()], { actorId: 'mgr-1' })
    expect(db.inserts).toEqual([
      { block_id: 'blk-1', profile_id: A, assigned_by: 'mgr-1', notes: null },
      { block_id: 'blk-1', profile_id: B, assigned_by: 'mgr-1', notes: null },
    ])
    expect(out.assigned.map((a) => a.profile_id)).toEqual([A, B])
    expect(out.skipped).toEqual([])
    expect(loadBlockCandidates).toHaveBeenCalledWith(db, { block: expect.objectContaining({ id: 'blk-1' }), audience: 'manager' })
  })

  it('skips a coach no longer active at the studio (not among the candidates)', async () => {
    loadBlockCandidates.mockResolvedValue({ candidates: [cand(B)], checked: ALL_CHECKED, error: null })
    const db = fakeDb()
    const out = await fillUsualCoaches(db, [block()])
    expect(db.inserts.map((r) => r.profile_id)).toEqual([B])
    expect(out.skipped).toEqual([{ block_id: 'blk-1', profile_id: A, reason: 'not_at_studio' }])
  })

  it('never assigns over approved leave, a cannot-work rule or a clashing shift', async () => {
    loadBlockCandidates.mockResolvedValue({
      candidates: [cand(A, { on_leave: { label: 'Holiday' } }), cand(B, { free: false }), cand(C, { unavailable: { summary: 'x' } })],
      checked: ALL_CHECKED, error: null,
    })
    const db = fakeDb()
    const tpl = { ...block().shift_templates, usual_coach_ids: [A, B, C] }
    const out = await fillUsualCoaches(db, [block({ shift_templates: tpl })])
    expect(db.inserts).toEqual([])
    expect(out.counts).toEqual({ time_off: 1, clash: 1, unavailable: 1 })
  })

  it('never overwrites: a shift with a live coach is left alone (a cancelled one does not count)', async () => {
    const db = fakeDb()
    const staffed = block({ id: 'blk-s', shift_assignments: [{ profile_id: C, status: 'scheduled' }] })
    const cancelledOnly = block({ id: 'blk-c', shift_assignments: [{ profile_id: C, status: 'cancelled' }] })
    const out = await fillUsualCoaches(db, [staffed, cancelledOnly])
    expect(out.skipped).toContainEqual({ block_id: 'blk-s', profile_id: null, reason: 'already_staffed' })
    expect(db.inserts.every((r) => r.block_id === 'blk-c')).toBe(true)
    expect(db.inserts).toHaveLength(2)
  })

  it('leaves a shift on a published roster for the manager', async () => {
    const db = fakeDb()
    const out = await fillUsualCoaches(db, [block({ roster_id: 'r1', rosters: { status: 'published' } })])
    expect(db.inserts).toEqual([])
    expect(out.counts).toEqual({ published: 1 })
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })

  it('stops at the shift maximum', async () => {
    const db = fakeDb()
    const out = await fillUsualCoaches(db, [block({ max_coaches: 1 })])
    expect(db.inserts.map((r) => r.profile_id)).toEqual([A])
    expect(out.skipped).toEqual([{ block_id: 'blk-1', profile_id: B, reason: 'at_capacity' }])
  })

  it('fails closed when a fact could not be checked', async () => {
    loadBlockCandidates.mockResolvedValue({ candidates: [cand(A), cand(B)], checked: { ...ALL_CHECKED, leave: false }, error: null })
    const db = fakeDb()
    const out = await fillUsualCoaches(db, [block()])
    expect(db.inserts).toEqual([])
    expect(out.counts).toEqual({ unchecked: 2 })
    loadBlockCandidates.mockResolvedValue({ error: { message: 'down' } })
    expect((await fillUsualCoaches(db, [block()])).counts).toEqual({ unchecked: 2 })
    expect(logWarn).toHaveBeenCalled()
    // No name in any log line.
    for (const call of logWarn.mock.calls) expect(JSON.stringify(call)).not.toMatch(/full_name/)
  })

  it('fills shifts in time order with a fresh read each, so an earlier fill counts as a clash', async () => {
    const order = []
    loadBlockCandidates.mockImplementation(async (_db, { block: b }) => {
      order.push(b.id)
      // The second shift sees A busy (A was just put on the first).
      return { candidates: [cand(A, { free: order.length === 1 }), cand(B)], checked: ALL_CHECKED, error: null }
    })
    const db = fakeDb()
    const late = block({ id: 'blk-late', start_time: '09:30:00' })
    const early = block({ id: 'blk-early', start_time: '09:00:00' })
    const out = await fillUsualCoaches(db, [late, early])
    expect(order).toEqual(['blk-early', 'blk-late'])
    expect(out.skipped).toContainEqual({ block_id: 'blk-late', profile_id: A, reason: 'clash' })
  })

  it('treats a duplicate insert as already on, and another write error as a skip', async () => {
    const db = fakeDb({ insertErrors: { [A]: { code: '23505', message: 'dup' }, [B]: { code: 'XX000', message: 'boom' } } })
    const out = await fillUsualCoaches(db, [block()])
    expect(out.assigned).toEqual([])
    expect(out.counts).toEqual({ already_on: 1, write_failed: 1 })
  })

  it('ignores templates with no usual coaches or deactivated', async () => {
    const db = fakeDb()
    const none = block({ shift_templates: { ...block().shift_templates, usual_coach_ids: [] } })
    const off = block({ shift_templates: { ...block().shift_templates, active: false } })
    const out = await fillUsualCoaches(db, [none, off])
    expect(out).toEqual({ assigned: [], skipped: [], counts: {} })
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })
})

describe('readBlocksForFill', () => {
  it('reads by id, or a studio range paged with an order', async () => {
    const db = fakeDb({ selectResult: { data: [{ id: 'x' }], error: null } })
    expect((await readBlocksForFill(db, { blockIds: ['x', 'x'] })).blocks).toEqual([{ id: 'x' }])
    expect(db.selects[0].q.calls).toContainEqual(['in', 'id', ['x']])
    await readBlocksForFill(db, { locationId: 'loc-1', startDate: '2026-12-07', endDate: '2026-12-13' })
    const calls = db.selects[1].q.calls
    expect(calls).toContainEqual(['eq', 'location_id', 'loc-1'])
    expect(calls.some((c) => c[0] === 'order')).toBe(true)
    expect(calls.some((c) => c[0] === 'range')).toBe(true)
  })
})
