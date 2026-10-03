// src/app/api/schedule/blocks/[id]/route.edit.test.js
// BLOCKEDIT.1 — PUT /api/schedule/blocks/[id]: edit one shift.
// (The DELETE suite lives in route.test.js and is untouched.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((user) => (user.locations || []).map((l) => l.id)),
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/shift-unassign', () => ({ logAndNotifyUnassignments: vi.fn() }))
vi.mock('@/lib/shift-overlaps', () => ({ findShiftOverlaps: vi.fn(async () => ({ clashes: [] })) }))
let logSeq = 0
vi.mock('@/lib/roster-change-log', () => ({
  logRosterChange: vi.fn(async () => ({ logged: true, id: `log-${++logSeq}` })),
  logBlockEdit: vi.fn(async () => ({ logged: true, id: 'blk-log' })),
  markChangesNotified: vi.fn(async () => {}),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logRosterChange, logBlockEdit, markChangesNotified } = await import('@/lib/roster-change-log')
const { findShiftOverlaps } = await import('@/lib/shift-overlaps')
const { PUT } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MANAGER = { id: 'mgr-1', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const on = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'scheduled', start_time_override: null, end_time_override: null, profiles: { full_name: name }, ...over })
const BLOCK = {
  id: 'blk-1', location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-30',
  start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null, roster_id: 'r1',
  rosters: { status: 'published' }, locations: { timezone: 'Europe/Dublin' },
  shift_templates: { name: 'Morning', kind: 'class' },
  shift_assignments: [on('u1', 'Coach A')],
}

// A chain whose every filter returns itself and whose await resolves `result`.
function chain(result, calls) {
  const b = {}
  for (const m of ['select', 'eq', 'is', 'in']) b[m] = (...a) => { calls.push([m, ...a]); return b }
  b.maybeSingle = () => Promise.resolve(result)
  b.then = (res, rej) => Promise.resolve(result).then(res, rej)
  return b
}

function makeDb({ block = BLOCK, readError = null, saveResult, followResult } = {}) {
  const captured = { read: [], save: [], savePatch: null, follows: [] }
  return {
    captured,
    from(table) {
      if (table === 'shift_blocks') {
        return {
          select: (cols) => { captured.readSelect = cols; return chain({ data: readError ? null : block, error: readError }, captured.read) },
          update: (patch) => {
            captured.savePatch = patch
            return chain(saveResult ?? { data: [{ id: block.id, ...patch }], error: null }, captured.save)
          },
        }
      }
      if (table === 'shift_assignments') {
        return {
          update: (patch) => {
            const calls = []
            captured.follows.push({ patch, calls })
            return chain(followResult ?? { data: [{ id: 'x' }], error: null }, calls)
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
// The path id must be UUID-shaped; the mocked read returns BLOCK whatever it is.
const params = { params: Promise.resolve({ id: 'c0000000-0000-0000-0000-0000000000b1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  logSeq = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T10:00:00Z')) // 11:00 Dublin, inside the band
  getCurrentUser.mockResolvedValue(MANAGER)
})
afterEach(() => { vi.useRealTimers() })

describe('PUT /api/schedule/blocks/[id] — who may', () => {
  it('403s someone who manages nowhere, before reading anything', async () => {
    getCurrentUser.mockResolvedValue({ id: 's', role: 'staff', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } })
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(403)
    expect(db.captured.readSelect).toBeUndefined()
  })

  it('404s an unknown block and a block at a studio the caller is not at, writing nothing', async () => {
    let db = makeDb({ block: null })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(404)
    db = makeDb({ block: { ...BLOCK, location_id: 'b0000000-0000-0000-0000-000000000002' } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(404)
    expect(db.captured.savePatch).toBeNull()
  })

  it("403s a manager elsewhere who is only staff at the block's studio (SCHEDROLES.1)", async () => {
    const LOC_B = 'b0000000-0000-0000-0000-000000000002'
    getCurrentUser.mockResolvedValue({ id: 'h', role: 'manager', profileRole: 'staff', locations: [{ id: LOC }, { id: LOC_B }], rolesByLocation: { [LOC]: 'staff', [LOC_B]: 'manager' } })
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(403)
    expect(db.captured.savePatch).toBeNull()
  })

  it('404s an id that is not UUID-shaped without reading (Postgres would 22P02 it into a 503)', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ start_time: '10:00' }), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(404)
    expect(db.captured.readSelect).toBeUndefined()
  })

  it('a failed read is a 503 to retry, never a 404', async () => {
    createServerClient.mockReturnValue(makeDb({ readError: { message: 'timeout' } }))
    const res = await PUT(req({ start_time: '10:00' }), params)
    expect(res.status).toBe(503)
  })

  it('reads the kind, the studio clock and the coaches in ONE literal select', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00' }), params)
    expect(db.captured.readSelect).toMatch(/shift_templates \( name, kind \)/)
    expect(db.captured.readSelect).toMatch(/locations:location_id \( timezone \)/)
    expect(db.captured.readSelect).toMatch(/briefing/)
  })
})

describe('PUT /api/schedule/blocks/[id] — refusals come from the planner', () => {
  it('400 end before start, 400 min above max, 400 admin minimum, 409 below the coaches on it', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await (await PUT(req({ end_time: '08:00' }), params)).json()).error).toBe('end_not_after_start')
    expect((await (await PUT(req({ min_coaches: 5 }), params)).json()).error).toBe('min_above_max')
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' } } }))
    const admin = await PUT(req({ min_coaches: 1 }), params)
    expect(admin.status).toBe(400)
    expect((await admin.json()).error).toBe('admin_has_no_minimum')
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A'), on('u2', 'Coach B')] } }))
    const below = await PUT(req({ max_coaches: 1, min_coaches: 1 }), params)
    expect(below.status).toBe(409)
    expect((await below.json()).error).toBe('below_assigned')
  })

  it('an unchanged body writes and logs nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '09:00', max_coaches: 3 }), params)).json()
    expect(body).toMatchObject({ success: true, unchanged: true })
    expect(db.captured.savePatch).toBeNull()
    expect(logBlockEdit).not.toHaveBeenCalled()
  })
})

describe('PUT /api/schedule/blocks/[id] — the write', () => {
  it('guards the UPDATE on the times and capacity it read, scoped to the studio', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00', end_time: '13:00' }), params)
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00', end_time: '13:00:00' })
    expect(db.captured.save).toEqual(expect.arrayContaining([
      ['eq', 'id', 'blk-1'], ['eq', 'location_id', LOC],
      ['eq', 'start_time', '09:00:00'], ['eq', 'end_time', '12:00:00'],
      ['eq', 'min_coaches', 1], ['eq', 'max_coaches', 3],
    ]))
  })

  it('a zero-row UPDATE means someone else changed it: 409, nothing logged', async () => {
    createServerClient.mockReturnValue(makeDb({ saveResult: { data: [], error: null } }))
    const res = await PUT(req({ start_time: '10:00' }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('block_changed')
    expect(logBlockEdit).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
  })

  it('a CHECK refusal is a 400 the editor can show, not a 500', async () => {
    createServerClient.mockReturnValue(makeDb({ saveResult: { data: null, error: { code: '23514', message: 'violates check constraint' } } }))
    expect((await PUT(req({ briefing: 'x' }), params)).status).toBe(400)
  })

  it('clears an override equal to the old block time, guarded on its old value', async () => {
    const db = makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '09:00:00' })] } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00' }), params)
    expect(db.captured.follows).toHaveLength(1)
    expect(db.captured.follows[0].patch).toEqual({ start_time_override: null })
    expect(db.captured.follows[0].calls).toEqual(expect.arrayContaining([
      ['eq', 'id', 'a-u1'], ['eq', 'block_id', 'blk-1'], ['eq', 'start_time_override', '09:00:00'],
    ]))
  })

  it("an override that could not follow: saved anyway, the coach is logged at the time they really have, and a warning says so", async () => {
    const db = makeDb({
      block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '09:00:00' })] },
      followResult: { data: [], error: null },
    })
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '10:00', end_time: '13:00' }), params)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toMatch(/Coach A/)
    expect(logRosterChange.mock.calls[0][1].details.to).toEqual({ start_time: '09:00:00', end_time: '13:00:00' })
  })
})

describe('PUT /api/schedule/blocks/[id] — change log and notice (published only)', () => {
  it('published: one block_edited row, one time_changed row per moved coach, notice "shortly" in band', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '10:00', end_time: '13:00', min_coaches: 2 }), params)).json()
    expect(logBlockEdit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      isPublished: true, locationId: LOC, blockId: 'blk-1', blockDate: '2026-09-30', actorId: 'mgr-1',
      details: expect.objectContaining({ source: 'block_edit', min_coaches: { from: 1, to: 2 } }),
    }))
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({
      isPublished: true, action: 'time_changed', coachId: 'u1', actorId: 'mgr-1', blockId: 'blk-1',
      details: { source: 'block_edit', from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' } },
    })
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(body.notice).toEqual({ coaches: 1, when: 'shortly' })
  })

  it('in quiet hours the save still lands; the notice says morning', async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z')) // 23:30 Dublin
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00' })
    expect(body.notice).toEqual({ coaches: 1, when: 'morning' })
  })

  // Review fix 3 — a shift that starts before 07:00 on the morning the notice
  // could first go out will have started before anyone is told.
  it("in quiet hours, a new start before 7am on the notice morning: 'too_late'", async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z')) // 23:30 Dublin; notices from 07:00 on the 30th
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '06:30' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'too_late' })
  })

  it("an OLD start before 7am counts too (the coach may turn up at the old time)", async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z'))
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, start_time: '06:00:00' } }))
    const body = await (await PUT(req({ start_time: '08:00' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'too_late' })
  })

  it("before 07:00 the same day's early shift is too late as well", async () => {
    vi.setSystemTime(new Date('2026-09-30T04:00:00Z')) // 05:00 Dublin on the shift's own day
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '06:30' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'too_late' })
  })

  it('a start before 7am on a LATER day is only morning', async () => {
    vi.setSystemTime(new Date('2026-09-28T22:30:00Z')) // 23:30 on the 28th; notice morning is the 29th
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '06:30' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'morning' })
  })

  it('a draft block is saved but not logged and nobody is told (drafts ride the first publish)', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, rosters: { status: 'draft' } } }))
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(body.success).toBe(true)
    expect(logBlockEdit).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.notice).toBeUndefined()
  })

  it('a past shift, or the manager moving their own shift: logged, stamped at once, nobody told', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-28' } }))
    let body = await (await PUT(req({ start_time: '10:00', confirm_past: true }), params)).json()
    expect(markChangesNotified).toHaveBeenCalledWith(expect.anything(), ['log-1'])
    // Second review 3 — logged as not needed, and the answer says why.
    expect(logRosterChange.mock.calls[0][1].details.notice).toBe('not_needed')
    expect(body.notice).toEqual({ coaches: 1, when: 'past' })

    vi.clearAllMocks()
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('mgr-1', 'Manager B')] } }))
    body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(body.notice).toBeUndefined()
  })

  it('a coach who kept their own hours is not logged and is named in the warning', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '10:30:00' })] } }))
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.kept_overrides).toEqual([{ assignment_id: 'a-u1', profile_id: 'u1' }])
    expect(body.warning).toMatch(/Coach A keeps their own hours/)
  })

  it('a briefing-only edit logs block_edited and tells nobody', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ briefing: 'Fire drill at 10' }), params)).json()
    expect(body.data.briefing).toBe('Fire drill at 10')
    expect(logBlockEdit.mock.calls[0][1].details).toEqual({ source: 'block_edit', briefing: 'added' })
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.notice).toBeUndefined()
  })
})

// Review fix 2 — the guard must compare against what the manager OPENED, not
// only against the route's own read a few ms earlier.
describe('PUT /api/schedule/blocks/[id] — expected (review fix 2)', () => {
  const OPENED = { start_time: '09:00', end_time: '12:00', min_coaches: 1, max_coaches: 3 }

  it('409 block_changed when the stored shift differs from what the form opened with; nothing written', async () => {
    const db = makeDb({ block: { ...BLOCK, start_time: '08:00:00' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ briefing: 'x', expected: OPENED }), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('block_changed')
    expect(body.message).toMatch(/Someone changed this shift since you opened it/)
    expect(db.captured.savePatch).toBeNull()
  })

  it('a stale capacity is caught too', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, max_coaches: 4 } }))
    expect((await PUT(req({ briefing: 'x', expected: OPENED }), params)).status).toBe(409)
  })

  it('matching expected values (HH:MM vs HH:MM:SS) save, and the conditional UPDATE still guards', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ start_time: '10:00', expected: OPENED }), params)
    expect(res.status).toBe(200)
    expect(db.captured.save).toEqual(expect.arrayContaining([['eq', 'start_time', '09:00:00'], ['eq', 'max_coaches', 3]]))
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00' })
  })

  it('expected is not an edit on its own', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await PUT(req({ expected: OPENED }), params)
    expect((await res.json()).error).toBe('nothing_to_change')
  })
})

// Review fix 4 — moving or stretching a shift can put a coach on two shifts at
// once. Warned (never blocked), with the assign route's org-scoped check.
describe('PUT /api/schedule/blocks/[id] — double-booking advisory (review fix 4)', () => {
  it("checks each moved coach's NEW window and lists any clash in the response and the warning", async () => {
    findShiftOverlaps.mockResolvedValueOnce({ clashes: [{ profileId: 'u1', name: 'Coach A', text: 'Coach A is already on Evening 13:00–15:00 at Studio Two that day — overlaps this shift.' }] })
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '10:00', end_time: '14:00' }), params)).json()
    expect(findShiftOverlaps).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      locationId: LOC, blockId: 'blk-1', blockDate: '2026-09-30',
      windows: [{ profileId: 'u1', start_time: '10:00:00', end_time: '14:00:00' }],
    }))
    expect(body.success).toBe(true)
    expect(body.overlaps).toEqual([{ profile_id: 'u1', message: 'Coach A is already on Evening 13:00–15:00 at Studio Two that day — overlaps this shift.' }])
    expect(body.warning).toMatch(/already on Evening/)
  })

  it('an edit that moves nobody does not look', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ briefing: 'x' }), params)).json()
    expect(findShiftOverlaps).not.toHaveBeenCalled()
    expect(body.overlaps).toBeUndefined()
  })
})


// Review nit — the cap is on the TRIMMED briefing: 500 characters padded with
// whitespace (a pasted note) is a valid briefing, not a 400.
describe('PUT /api/schedule/blocks/[id] — briefing length (review nit)', () => {
  it('trims before the 500 cap', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ briefing: `  ${'a'.repeat(500)}\n\n` }), params)
    expect(res.status).toBe(200)
    expect(db.captured.savePatch).toEqual({ briefing: 'a'.repeat(500) })
  })

  it('501 real characters is still a 400', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await PUT(req({ briefing: 'a'.repeat(501) }), params)).status).toBe(400)
  })
})

// Review nit — changing a past shift changes paid hours, so it is asked for
// explicitly (the form confirms first).
describe('PUT /api/schedule/blocks/[id] — past shifts need confirm_past (review nit)', () => {
  const PAST = { ...BLOCK, block_date: '2026-09-28' } // today is 2026-09-29 (Dublin)

  it('409 past_shift without confirm_past; nothing written', async () => {
    const db = makeDb({ block: PAST })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ start_time: '10:00' }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('past_shift')
    expect(db.captured.savePatch).toBeNull()
  })

  it('saves with confirm_past: true', async () => {
    const db = makeDb({ block: PAST })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00', confirm_past: true }), params)).status).toBe(200)
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00' })
  })

  it("today's shift is not past", async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-29' } }))
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(200)
  })

  it('confirm_past alone is not an edit', async () => {
    createServerClient.mockReturnValue(makeDb({ block: PAST }))
    expect((await (await PUT(req({ confirm_past: true }), params)).json()).error).toBe('nothing_to_change')
  })
})

// BLOCKEDIT.1 second review 3 — a shift that has already ENDED today is past
// too (D8: past shifts are never messaged). It is logged, stamped as
// not_needed at once, and the answer is when: 'past'. Before, it was messaged
// during the day, and after 22:00 answered 'morning' for a notice the arm
// (which reads today-or-later dates only) would never send or stamp.
describe('PUT /api/schedule/blocks/[id] — a shift that already ended today (second review 3)', () => {
  it('ended earlier today (11:00 Dublin, shift 06:00-08:00): not_needed, stamped, when past', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-29', start_time: '06:00:00', end_time: '08:00:00' } }))
    const body = await (await PUT(req({ start_time: '06:30' }), params)).json()
    expect(logRosterChange.mock.calls[0][1].details).toMatchObject({ source: 'block_edit', notice: 'not_needed' })
    expect(markChangesNotified).toHaveBeenCalledWith(expect.anything(), ['log-1'])
    expect(body.notice).toEqual({ coaches: 1, when: 'past' })
  })

  it("after 22:00, today's finished shift is past, not 'morning'", async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z')) // 23:30 Dublin
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-29' } }))
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'past' })
    expect(markChangesNotified).toHaveBeenCalled()
  })

  it('a RUNNING shift whose end moves later is still told', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-29' } })) // 09-12, now 11:00
    const body = await (await PUT(req({ end_time: '13:00' }), params)).json()
    expect(logRosterChange.mock.calls[0][1].details.notice).toBeUndefined()
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(body.notice).toEqual({ coaches: 1, when: 'shortly' })
  })

  it('an ended shift pulled back into the future (end moved past now) is still told', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-29', start_time: '06:00:00', end_time: '08:00:00' } }))
    const body = await (await PUT(req({ end_time: '13:00' }), params)).json()
    expect(body.notice).toEqual({ coaches: 1, when: 'shortly' })
  })
})

// Second review nit — when clearing an override fails, the coach keeps the old
// override, and against the new block times that can be a window that ends
// before it starts. Say so, by name, and do not announce a backwards window.
describe('PUT /api/schedule/blocks/[id] — a stuck override that no longer fits (second review nit)', () => {
  it('warns naming the coach, and logs no time change for them', async () => {
    const db = makeDb({
      block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '09:00:00' })] },
      followResult: { data: [], error: null },
    })
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '06:00', end_time: '08:00' }), params)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toMatch(/Coach A's own hours are now 9am–8am, which ends before it starts/)
    expect(logRosterChange).not.toHaveBeenCalled()
  })
})

// Second review nit — 'too_late' covers starts before 07:30: a notice sent at
// 07:00 is no use for a 07:10 start.
describe('PUT /api/schedule/blocks/[id] — too_late threshold (second review nit)', () => {
  it('07:10 is too late; 07:30 is morning', async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z')) // 23:30 Dublin
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, start_time: '07:10:00' } }))
    expect((await (await PUT(req({ end_time: '11:00' }), params)).json()).notice).toEqual({ coaches: 1, when: 'too_late' })
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, start_time: '07:30:00' } }))
    expect((await (await PUT(req({ end_time: '11:00' }), params)).json()).notice).toEqual({ coaches: 1, when: 'morning' })
  })
})

