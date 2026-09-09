// ROSTER-FIX.4 — POST /api/schedule/rosters overlap guard.
//
// Two published rosters covering the same date at the same location make
// "which roster published this day" ambiguous: the block tagging update
// rewrites roster_id for the whole period, so the older roster silently
// loses its blocks while its row still claims the dates.
//
// The rules the tests pin:
//   exact same period      → allowed (this is how a re-notify works)
//   strictly wider period  → allowed (the documented "publish the month
//                            after publishing a week" flow)
//   contained / straddling → 409 overlapping_roster, nothing inserted

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => [LOC_1]),
}))
// ROSTER-FIX.4 — only the budget projection is stubbed. The overlap guard
// stays REAL (findConflictingPublishedRosters), so these cases exercise the
// helper the approve endpoint shares rather than a mock of it.
vi.mock('@/lib/roster-publish', async (importOriginal) => ({
  ...(await importOriginal()),
  projectPublishImpact: vi.fn(),
}))
vi.mock('@/lib/roster-email', () => ({ sendOverBudgetApprovalEmail: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/roster-notify', () => ({
  notifyStaffOfPublish: vi.fn(() => Promise.resolve()),
  publishNotifyRowsForBlocks: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@/lib/notify', () => ({ notifyUsers: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/roster-change-log', () => ({
  collectUnnotifiedChanges: vi.fn(() => Promise.resolve([])),
  markChangesNotified: vi.fn(() => Promise.resolve()),
  distinctCoachIds: vi.fn(() => []),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { projectPublishImpact } = await import('@/lib/roster-publish')
const { POST } = await import('./route.js')

// location_id is validated as UUID-shaped, so the fixture has to be one.
const LOC_1 = 'a0000000-0000-0000-0000-000000000001'

const UNDER_BUDGET = {
  monthStart: '2026-05-01', monthEnd: '2026-05-31',
  monthlyBudgetEur: 5000, alreadyPublishedEur: 0, periodProjectedEur: 100,
  monthProjectedTotalEur: 100, remainingEur: 4900, overBudget: false,
  overrunEur: 0, blockCount: 1,
}

function req(body) {
  return { json: () => Promise.resolve(body) }
}

// Minimal Supabase-shaped mock. `rosters` selects resolve to
// `publishedRosters` (the overlap probe); the insert resolves to a row;
// shift_blocks reads resolve empty and writes are recorded.
function buildDb({ publishedRosters = [] } = {}) {
  const inserts = []
  const db = {
    from(table) {
      if (table === 'rosters') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          lte: () => chain,
          gte: () => chain,
          order: () => chain,
          neq: () => chain,
          in: () => chain,
          then: (onF, onR) => Promise.resolve({ data: publishedRosters, error: null }).then(onF, onR),
          insert(payload) {
            inserts.push(payload)
            return {
              select: () => ({ single: () => Promise.resolve({ data: { id: 'roster-new', ...payload }, error: null }) }),
            }
          },
        }
        return chain
      }
      if (table === 'shift_blocks') {
        const chain = {
          select: () => chain,
          update: () => chain,
          eq: () => chain,
          gte: () => chain,
          lte: () => chain,
          is: () => chain,
          then: (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR),
        }
        return chain
      }
      throw new Error('unexpected table: ' + table)
    },
  }
  return { db, inserts }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  projectPublishImpact.mockReset()
  projectPublishImpact.mockResolvedValue(UNDER_BUDGET)
  getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: LOC_1 }] })
})

function publish(body) {
  return POST(req({ location_id: LOC_1, period_start: '2026-05-04', period_end: '2026-05-10', ...body }))
}

describe('POST /api/schedule/rosters — overlapping published rosters', () => {
  it('refuses a week that sits INSIDE an already-published month', async () => {
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('overlapping_roster')
    expect(body.overlapping).toEqual([{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }])
    expect(inserts).toHaveLength(0)
  })

  it('refuses a period that only partly straddles a published one', async () => {
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(409)
    expect(inserts).toHaveLength(0)
  })

  it('allows an EXACT re-publish of the same period (this is the re-notify path)', async () => {
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(201)
    expect(inserts).toHaveLength(1)
  })

  it('allows a WIDER period that fully contains the published one', async () => {
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ location_id: LOC_1, period_start: '2026-05-01', period_end: '2026-05-31' }))
    expect(res.status).toBe(201)
    expect(inserts).toHaveLength(1)
  })

  it('publishes normally when nothing overlaps', async () => {
    const { db, inserts } = buildDb({ publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(201)
    expect(inserts[0].status).toBe('published')
  })

  it('a dry run reports the conflict too, so the modal warns before committing', async () => {
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish({ dry_run: true })
    expect(res.status).toBe(409)
    expect(inserts).toHaveLength(0)
  })

  it('an over-budget manager draft is refused too — a draft becomes a published roster on approval', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC_1 }] })
    projectPublishImpact.mockResolvedValue({ ...UNDER_BUDGET, overBudget: true, overrunEur: 50 })
    const { db, inserts } = buildDb({
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(409)
    expect(inserts).toHaveLength(0)
  })
})
