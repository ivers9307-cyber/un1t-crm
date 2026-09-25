// ROSTER-FIX.2 — what GET /api/schedule/blocks shows a coach.
//
// The schedule calendar is a coach surface (ScheduleRosterView renders
// ScheduleCalendar for every role), so this feed is not manager-only. For a
// non-manager it is narrowed instead: D1 — coaches never see DRAFT shifts —
// and capacity (min/max_coaches), block notes and per-assignment notes /
// partial_reason are manager information that never reaches a coach.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    getUserLocationIds: vi.fn(() => ['loc-1']),
    // SCHEDROLES.1 — the REAL helpers (they were a hand copy of the contract).
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

function req(url = 'http://x/api/schedule/blocks?location_id=loc-1') {
  return { url, headers: { get: () => '' } }
}

function buildDb(rows) {
  const q = {}
  for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = () => q
  q.then = (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej)
  return { from: () => ({ select: () => q }) }
}

const PUBLISHED_BLOCK = {
  id: 'b-pub',
  location_id: 'loc-1',
  template_id: 't-1',
  block_date: '2026-06-01',
  start_time: '06:00:00',
  end_time: '10:00:00',
  roster_id: 'r-pub',
  min_coaches: 1,
  max_coaches: 4,
  notes: 'manager-only block note',
  rosters: { status: 'published' },
  shift_templates: {
    id: 't-1', name: 'Morning', color: '#fff', role_label: 'Coach',
    start_time: '06:00:00', end_time: '10:00:00', days_of_week: [1], max_coaches: 4,
  },
  shift_assignments: [
    {
      id: 'a-1',
      profile_id: 'p-1',
      notes: 'manager-only assignment note',
      status: 'assigned',
      assigned_at: '2026-05-01T00:00:00Z',
      start_time_override: null,
      end_time_override: null,
      partial_reason: 'left early for physio',
      profiles: { id: 'p-1', full_name: 'Ada', email: 'ada@x.ie', avatar_url: null, role: 'staff' },
    },
    {
      id: 'a-2',
      profile_id: 'p-2',
      notes: null,
      status: 'cancelled',
      assigned_at: '2026-05-01T00:00:00Z',
      start_time_override: null,
      end_time_override: null,
      partial_reason: null,
      profiles: { id: 'p-2', full_name: 'Grace', email: 'grace@x.ie', avatar_url: null, role: 'staff' },
    },
  ],
}

const DRAFT_BLOCK = {
  ...PUBLISHED_BLOCK,
  id: 'b-draft',
  roster_id: 'r-draft',
  rosters: { status: 'draft' },
  shift_assignments: [],
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('GET /api/schedule/blocks — coach view', () => {
  it('200, published blocks only, in a capacity-free shape', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(buildDb([PUBLISHED_BLOCK, DRAFT_BLOCK]))

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    // D1 — the draft roster's block is not there.
    expect(body.data.map((b) => b.id)).toEqual(['b-pub'])

    const block = body.data[0]
    // Capacity + manager notes are absent as KEYS, not merely null.
    expect('max_coaches' in block).toBe(false)
    expect('min_coaches' in block).toBe(false)
    expect('notes' in block).toBe(false)
    expect('max_coaches' in block.shift_templates).toBe(false)

    // Cancelled assignments are gone; the live one carries no manager notes.
    expect(block.shift_assignments.map((a) => a.id)).toEqual(['a-1'])
    const assignment = block.shift_assignments[0]
    expect('notes' in assignment).toBe(false)
    expect('partial_reason' in assignment).toBe(false)

    // What a coach does keep: the time, the shift, and who is on it.
    expect(block.start_time).toBe('06:00:00')
    expect(block.shift_templates.name).toBe('Morning')
    expect(assignment.profiles.full_name).toBe('Ada')
    // COACHSCOPE.1 — a colleague's name, not their email.
    expect(assignment.profiles).toEqual({ id: 'p-1', full_name: 'Ada', avatar_url: null, role: 'staff' })
  })

  it('COACHSCOPE.1 — judges the role at the BLOCK\'s location, not the active one', async () => {
    // Active-location role says head_coach (Hatch); at loc-1 they are staff.
    getCurrentUser.mockResolvedValue({
      id: 'x', role: 'head_coach', profileRole: 'head_coach',
      rolesByLocation: { 'loc-1': 'staff', 'loc-hatch': 'head_coach' },
    })
    createServerClient.mockReturnValue(buildDb([PUBLISHED_BLOCK, DRAFT_BLOCK]))
    const body = await (await GET(req())).json()
    expect(body.data.map((b) => b.id)).toEqual(['b-pub'])
    expect('max_coaches' in body.data[0]).toBe(false)
  })

  it('drops a block whose roster is missing entirely', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(buildDb([{ ...PUBLISHED_BLOCK, roster_id: null, rosters: null }]))
    const res = await GET(req())
    const body = await res.json()
    expect(body.data).toEqual([])
  })
})

describe('GET /api/schedule/blocks — manager view', () => {
  it('200 with drafts and the full capacity shape, untouched', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    createServerClient.mockReturnValue(buildDb([PUBLISHED_BLOCK, DRAFT_BLOCK]))

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.map((b) => b.id)).toEqual(['b-pub', 'b-draft'])
    expect(body.data[0].max_coaches).toBe(4)
    expect(body.data[0].notes).toBe('manager-only block note')
    expect(body.data[0].shift_assignments).toHaveLength(2)
    expect(body.data[0].shift_assignments[0].partial_reason).toBe('left early for physio')
  })
})

// SHIFTTYPE.1 — the calendar and the phone read a block's kind from its
// template. A coach's slim shape keeps it (a coach's admin card gets the admin
// tone); it is not a capacity fact, so the capacity stripping is unchanged.
describe('GET /api/schedule/blocks — shift kind (SHIFTTYPE.1)', () => {
  function capturingDb(rows) {
    const captured = {}
    const q = {}
    for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = () => q
    q.then = (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej)
    return { captured, from: () => ({ select: (s) => { captured.select = s; return q } }) }
  }
  const ADMIN_BLOCK = { ...PUBLISHED_BLOCK, id: 'b-admin', shift_templates: { ...PUBLISHED_BLOCK.shift_templates, kind: 'admin' } }

  it('embeds the template kind for a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    const db = capturingDb([ADMIN_BLOCK])
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req())).json()
    expect(db.captured.select).toMatch(/shift_templates\(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches, kind\)/)
    expect(body.data[0].shift_templates.kind).toBe('admin')
  })

  it("keeps the kind in a coach's slim shape, and still no capacity", async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(capturingDb([ADMIN_BLOCK]))
    const body = await (await GET(req())).json()
    expect(body.data[0].shift_templates.kind).toBe('admin')
    expect('max_coaches' in body.data[0].shift_templates).toBe(false)
    expect('min_coaches' in body.data[0]).toBe(false)
  })
})

// DATECHECK.1 — the range bounds went to Postgres unchecked, and the route
// answered 400 with Postgres's own "date/time field value out of range".
describe('GET /api/schedule/blocks — a date the calendar does not have', () => {
  const MANAGER = { id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    for (const [qs, name] of [
      ['&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['&start_date=2026-04-27&end_date=2026-04-31', 'end_date'],
      ['&start_date=2026-13-01', 'start_date'],
      ['&end_date=soon', 'end_date'],
    ]) {
      const res = await GET(req(`http://x/api/schedule/blocks?location_id=loc-1${qs}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
    }
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('a real range (leap day included) still reads, bounded on block_date', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const q = {}
    for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = (...args) => { calls.push([op, ...args]); return q }
    q.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
    createServerClient.mockReturnValue({ from: () => ({ select: () => q }) })

    const res = await GET(req('http://x/api/schedule/blocks?location_id=loc-1&start_date=2028-02-28&end_date=2028-02-29'))
    expect(res.status).toBe(200)
    expect(calls).toContainEqual(['gte', 'block_date', '2028-02-28'])
    expect(calls).toContainEqual(['lte', 'block_date', '2028-02-29'])
  })
})

// ROSTER-FIX.4 — a manually-added block for a date inside an
// already-published period must join that roster, or the extra Saturday slot
// a manager just created is invisible to every coach.
describe('POST /api/schedule/blocks — post-publish blocks join the roster', () => {
  const LOC = 'a0000000-0000-0000-0000-000000000001'
  const TPL = 'a0000000-0000-0000-0000-000000000002'

  // templateAt: the studio TPL belongs to (null = whichever is asked).
  function postDb({ publishedRoster = null, restoreError = null, insertError = null, templateAt = null, templateKind = 'class' } = {}) {
    const captured = { insert: null, restore: null }
    const db = {
      captured,
      from(table) {
        // SLOTREMOVAL.1 — the undo: a manual create clears the slot's removal.
        if (table === 'shift_block_removals') {
          return {
            delete: () => {
              captured.restore = []
              const chain = {
                eq: (col, val) => { captured.restore.push([col, val]); return chain },
                then: (ok, err) => Promise.resolve({ data: null, error: restoreError }).then(ok, err),
              }
              return chain
            },
          }
        }
        if (table === 'rosters') {
          const chain = {
            select: () => chain, eq: () => chain, lte: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
            maybeSingle: () => Promise.resolve({ data: publishedRoster, error: null }),
          }
          return chain
        }
        if (table === 'shift_templates') {
          // SCHEDROLES.1 — the template read is scoped to its studio; a row
          // only comes back when (id, location_id) match `templateAt`.
          const f = {}
          const chain = {
            eq: (col, val) => { f[col] = val; return chain },
            maybeSingle: () => Promise.resolve({
              data: f.id === TPL && f.location_id === (templateAt ?? f.location_id)
                ? { start_time: '09:00', end_time: '10:00', max_coaches: 5, min_coaches: templateKind === 'admin' ? 0 : 1, kind: templateKind }
                : null,
              error: null,
            }),
          }
          return { select: () => chain }
        }
        if (table === 'shift_blocks') {
          return {
            insert: (row) => {
              captured.insert = row
              return { select: () => ({ single: () => Promise.resolve(insertError ? { data: null, error: insertError } : { data: { id: 'blk-new', ...row }, error: null }) }) }
            },
          }
        }
        throw new Error('unexpected table: ' + table)
      },
    }
    return db
  }

  function postReq(body) {
    return { json: () => Promise.resolve(body), headers: { get: () => '' } }
  }

  beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

  it('stamps roster_id when a published roster covers the date', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const db = postDb({ publishedRoster: { id: 'r-live' } })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(201)
    expect(db.captured.insert.roster_id).toBe('r-live')
  })

  it('leaves roster_id null when the date is not inside a published period', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const db = postDb({ publishedRoster: null })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(201)
    expect(db.captured.insert.roster_id).toBeNull()
  })

  // SLOTREMOVAL.1 — adding a deleted slot back by hand restores it, so the
  // nightly generator and roster copies treat it as a normal slot again.
  it('clears the removal row for exactly that location, template and date', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const db = postDb()
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(201)
    expect((await res.json()).warning).toBeUndefined()
    expect(db.captured.restore).toEqual([
      ['location_id', LOC], ['template_id', TPL], ['block_date', '2026-06-06'],
    ])
  })

  it('keeps the created block and returns a warning when clearing the removal fails', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const db = postDb({ restoreError: { message: 'delete boom' } })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')
    const { logWarn } = await import('@/lib/log')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.data.id).toBe('blk-new')
    expect(json.warning).toMatch(/removal could not be cleared/)
    expect(logWarn).toHaveBeenCalled()
  })

  it('does not touch the removal when the create fails', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const db = postDb({ insertError: { code: '23505', message: 'dup' } })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(409)
    expect(db.captured.restore).toBeNull()
  })

  // DATECHECK.1 — an impossible date used to reach the insert, which Postgres
  // refused with its own text as a 400, after a rosters read that logged a
  // warning and answered "not published".
  it('400s on a block_date the calendar does not have, and reads or writes nothing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
    const { POST } = await import('./route.js')

    for (const block_date of ['2026-02-30', '2026-06-31', '2027-02-29']) {
      const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid request body')
      expect(json.issues).toEqual([{ path: 'block_date', message: 'Use a real date, YYYY-MM-DD' }])
    }
    expect(createServerClient).not.toHaveBeenCalled()
  })

  // SCHEDROLES.1 — manager at LOC (their ACTIVE studio), staff at LOC_B. The
  // route used to read `user.role` and check only membership of the target.
  describe('role at body.location_id (SCHEDROLES.1)', () => {
    const LOC_B = 'b0000000-0000-4000-8000-000000000002'
    const mixed = (active) => ({
      id: 'mix', role: active === LOC ? 'manager' : 'staff', profileRole: 'staff',
      activeLocation: { id: active },
      locations: [{ id: LOC }, { id: LOC_B }],
      rolesByLocation: { [LOC]: 'manager', [LOC_B]: 'staff' },
    })

    it('refuses a slot at the studio where the caller is staff, and inserts nothing', async () => {
      getCurrentUser.mockResolvedValue(mixed(LOC))
      const db = postDb()
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      const res = await POST(postReq({ location_id: LOC_B, template_id: TPL, block_date: '2026-06-06' }))
      expect(res.status).toBe(403)
      expect(db.captured.insert).toBeNull()
    })

    it('allows a slot at the studio the caller manages', async () => {
      getCurrentUser.mockResolvedValue(mixed(LOC))
      createServerClient.mockReturnValue(postDb())
      const { POST } = await import('./route.js')
      expect((await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))).status).toBe(201)
    })

    it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
      getCurrentUser.mockResolvedValue(mixed(LOC_B))
      createServerClient.mockReturnValue(postDb())
      const { POST } = await import('./route.js')
      expect((await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))).status).toBe(201)
    })

    it('404s a template that belongs to another studio, even with every snapshot field supplied', async () => {
      getCurrentUser.mockResolvedValue(mixed(LOC))
      const db = postDb({ templateAt: LOC_B })
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      const res = await POST(postReq({
        location_id: LOC, template_id: TPL, block_date: '2026-06-06',
        start_time: '09:00', end_time: '10:00', max_coaches: 4, min_coaches: 1,
      }))
      expect(res.status).toBe(404)
      expect(db.captured.insert).toBeNull()
    })

    it('master is allowed', async () => {
      getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
      createServerClient.mockReturnValue(postDb())
      const { POST } = await import('./route.js')
      expect((await POST(postReq({ location_id: LOC_B, template_id: TPL, block_date: '2026-06-06' }))).status).toBe(201)
    })
  })

  // SHIFTTYPE.1 — a manual slot of an admin template has no minimum.
  describe('admin template (SHIFTTYPE.1)', () => {
    const MGR = { id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }

    it("an admin template's slot is created with minimum 0", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb({ templateKind: 'admin' })
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      expect((await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))).status).toBe(201)
      expect(db.captured.insert.min_coaches).toBe(0)
    })

    it("refuses an explicit minimum on an admin template's slot, and inserts nothing", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb({ templateKind: 'admin' })
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06', min_coaches: 2 }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('admin_has_no_minimum')
      expect(db.captured.insert).toBeNull()
    })

    it("a class template's slot still takes the template minimum", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb()
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
      expect(db.captured.insert.min_coaches).toBe(1)
    })
  })
})
