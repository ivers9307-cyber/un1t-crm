// ROSTER-FIX.2 — what GET /api/schedule/blocks shows a coach.
//
// The schedule calendar is a coach surface (ScheduleRosterView renders
// ScheduleCalendar for every role), so this feed is not manager-only. For a
// non-manager it is narrowed instead: D1 — coaches never see DRAFT shifts —
// and capacity (min/max_coaches), block notes and per-assignment notes /
// partial_reason are manager information that never reaches a coach.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))

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
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff' })
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
  })

  it('drops a block whose roster is missing entirely', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff' })
    createServerClient.mockReturnValue(buildDb([{ ...PUBLISHED_BLOCK, roster_id: null, rosters: null }]))
    const res = await GET(req())
    const body = await res.json()
    expect(body.data).toEqual([])
  })
})

describe('GET /api/schedule/blocks — manager view', () => {
  it('200 with drafts and the full capacity shape, untouched', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager' })
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

// ROSTER-FIX.4 — a manually-added block for a date inside an
// already-published period must join that roster, or the extra Saturday slot
// a manager just created is invisible to every coach.
describe('POST /api/schedule/blocks — post-publish blocks join the roster', () => {
  const LOC = 'a0000000-0000-0000-0000-000000000001'
  const TPL = 'a0000000-0000-0000-0000-000000000002'

  function postDb({ publishedRoster = null } = {}) {
    const captured = { insert: null }
    const db = {
      captured,
      from(table) {
        if (table === 'rosters') {
          const chain = {
            select: () => chain, eq: () => chain, lte: () => chain, gte: () => chain, limit: () => chain,
            maybeSingle: () => Promise.resolve({ data: publishedRoster, error: null }),
          }
          return chain
        }
        if (table === 'shift_templates') {
          return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { start_time: '09:00', end_time: '10:00', max_coaches: 5, min_coaches: 1 }, error: null }) }) }) }
        }
        if (table === 'shift_blocks') {
          return {
            insert: (row) => { captured.insert = row; return { select: () => ({ single: () => Promise.resolve({ data: { id: 'blk-new', ...row }, error: null }) }) } },
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
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', locations: [{ id: LOC }] })
    const db = postDb({ publishedRoster: { id: 'r-live' } })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(201)
    expect(db.captured.insert.roster_id).toBe('r-live')
  })

  it('leaves roster_id null when the date is not inside a published period', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', locations: [{ id: LOC }] })
    const db = postDb({ publishedRoster: null })
    createServerClient.mockReturnValue(db)
    const { POST } = await import('./route.js')

    const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
    expect(res.status).toBe(201)
    expect(db.captured.insert.roster_id).toBeNull()
  })
})
