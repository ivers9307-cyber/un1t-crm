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
const { POST, GET } = await import('./route.js')

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
function buildDb({ publishedRosters = [], insertError = null, insertThrows = null, tagError = null, blockDates = {} } = {}) {
  const inserts = []
  // ROSTER-SUPERSEDE.1 — rosters now also takes UPDATEs (the release before
  // the insert, the superseded_by stamp after the re-tag, the restore on a
  // failed insert). Each is recorded with the filters it was narrowed by, so
  // ordering against the insert can be asserted.
  const rosterUpdates = []
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
          is: () => chain,
          then: (onF, onR) => Promise.resolve({ data: publishedRosters, error: null }).then(onF, onR),
          insert(payload) {
            inserts.push(payload)
            return {
              select: () => ({
                // ROSTER-SUPERSEDE.1 — insertThrows is the failure mode the
                // error object cannot describe: a PostgREST 5xx, a dropped
                // fetch, the function timing out. It REJECTS.
                single: () => (insertThrows
                  ? Promise.reject(new Error(insertThrows))
                  : Promise.resolve({
                    data: insertError ? null : { id: 'roster-new', ...payload },
                    error: insertError,
                  })),
              }),
            }
          },
          update(payload) {
            const rec = { payload, where: [], afterInsert: inserts.length > 0 }
            rosterUpdates.push(rec)
            const w = {
              eq: (c, v) => { rec.where.push([c, v]); return w },
              in: (c, v) => { rec.where.push([c, v]); return w },
              is: (c, v) => { rec.where.push([c, v]); return w },
              // The superseded_by stamp reads back the rows it touched.
              select: () => ({
                then: (onF, onR) => {
                  const targeted = rec.where.find(([c]) => c === 'id')?.[1]
                  const ids = Array.isArray(targeted) ? targeted : [targeted].filter(Boolean)
                  return Promise.resolve({ data: ids.map((id) => ({ id })), error: null }).then(onF, onR)
                },
              }),
              then: (onF, onR) => Promise.resolve({ data: null, error: null }).then(onF, onR),
            }
            return w
          },
        }
        return chain
      }
      if (table === 'shift_blocks') {
        let isUpdate = false
        let head = false
        let rosterId = null
        let asc = true
        const chain = {
          select: (_c, opts) => { head = !!opts?.head; return chain },
          update: () => { isUpdate = true; return chain },
          eq: (c, v) => { if (c === 'roster_id') rosterId = v; return chain },
          gte: () => chain,
          lte: () => chain,
          is: () => chain,
          order: (_c, o) => { asc = o?.ascending !== false; return chain },
          limit: () => chain,
          maybeSingle: () => {
            const dates = [...(blockDates[rosterId] || [])].sort()
            const pick = asc ? dates[0] : dates[dates.length - 1]
            return Promise.resolve({ data: pick ? { block_date: pick } : null, error: null })
          },
          then: (onF, onR) => Promise.resolve(
            isUpdate
              ? { data: null, error: tagError }
              : head
                ? { data: null, count: (blockDates[rosterId] || []).length, error: null }
                : { data: [], error: null },
          ).then(onF, onR),
        }
        return chain
      }
      throw new Error('unexpected table: ' + table)
    },
  }
  return { db, inserts, rosterUpdates }
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


// ROSTER-SUPERSEDE.1 — the publish now RESOLVES the overlaps it is allowed to
// create instead of leaving a roster row claiming days it owns no blocks on.
// Ordering is the whole trick: mig 602's exclusion constraint judges the
// INSERT, which is necessarily before any block can carry the new roster's
// id, so the swallowed rosters are stood down BEFORE the insert and stamped
// with their successor AFTER the re-tag.
describe('POST /api/schedule/rosters — supersede', () => {
  it('stands the swallowed roster down BEFORE inserting, then stamps the successor', async () => {
    const { db, inserts, rosterUpdates } = buildDb({
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(201)
    expect(inserts).toHaveLength(1)

    const release = rosterUpdates.find((u) => u.payload.status === 'superseded')
    expect(release).toBeTruthy()
    // 🔴 Before the insert, or the constraint rejects it with a raw 23P01.
    expect(release.afterInsert).toBe(false)
    // The successor does not exist yet at release time.
    expect(release.payload.superseded_by).toBeNull()

    const stamp = rosterUpdates.find((u) => u.payload.superseded_by === 'roster-new')
    expect(stamp).toBeTruthy()
    expect(stamp.afterInsert).toBe(true)
  })

  it('stands down a week the new MONTH swallows', async () => {
    const { db, rosterUpdates } = buildDb({
      publishedRosters: [{ id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ location_id: LOC_1, period_start: '2026-05-01', period_end: '2026-05-31' }))
    expect(res.status).toBe(201)
    expect(rosterUpdates.some((u) => u.payload.status === 'superseded')).toBe(true)
  })

  it('an over-budget manager DRAFT supersedes nothing', async () => {
    // A draft owns no blocks until it is approved, so standing a live roster
    // down on its behalf would unpublish that period for a draft that may
    // never be approved.
    getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC_1 }] })
    projectPublishImpact.mockResolvedValue({ ...UNDER_BUDGET, overBudget: true, overrunEur: 50 })
    const { db, inserts, rosterUpdates } = buildDb({ publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(202)
    expect(inserts[0].status).toBe('draft')
    expect(rosterUpdates).toHaveLength(0)
  })

  it('puts the released rosters back when the insert fails', async () => {
    // Superseded with no successor, they still own their blocks — every one
    // would read as UNPUBLISHED to its coach.
    const { db, rosterUpdates } = buildDb({
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      insertError: { message: 'duplicate key' },
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(400)
    expect(rosterUpdates.at(-1).payload).toEqual({ status: 'published', superseded_at: null, superseded_by: null })
  })

  it('puts them back when the insert THROWS instead of returning an error', async () => {
    // 🔴 The failure the error-object branch cannot see: a PostgREST 5xx, a
    // dropped fetch, the function timing out. Unwrapped, the throw escaped the
    // route and the released rosters stayed superseded FOREVER, so one
    // transient blip silently unpublished a coach's whole week.
    const { db, rosterUpdates } = buildDb({
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      insertThrows: 'fetch failed',
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/fetch failed/)
    expect(rosterUpdates.at(-1).payload).toEqual({ status: 'published', superseded_at: null, superseded_by: null })
    expect(rosterUpdates.at(-1).where).toContainEqual(['id', ['r-same']])
  })

  it('a throw with nothing stood down still answers, and writes no restore', async () => {
    const { db, rosterUpdates } = buildDb({ publishedRosters: [], insertThrows: 'statement timeout' })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(500)
    expect(rosterUpdates).toHaveLength(0)
  })

  it('says so when tagging fails after the swallowed rosters were stood down', async () => {
    const { db } = buildDb({
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      tagError: { message: 'deadlock detected' },
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.warning).toMatch(/deadlock detected/)
    expect(body.warning).toMatch(/read as unpublished/)
  })

  it('a straddling overlap is still a 409 and stands nothing down', async () => {
    const { db, inserts, rosterUpdates } = buildDb({
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(409)
    expect(inserts).toHaveLength(0)
    expect(rosterUpdates).toHaveLength(0)
  })
})


// ROSTER-SUPERSEDE.1 — period_start/period_end get SHRUNK to the days a
// roster really owns, by mig 602's backfill and by every later publish that
// swallows part of it. requested_period_* is the operator's original ask and
// nothing but the insert can ever write it: left NULL here, the first shrink
// destroyed the only record of what was actually clicked.
describe('POST /api/schedule/rosters — the requested range is preserved', () => {
  it('a published roster carries the range the operator asked for', async () => {
    const { db, inserts } = buildDb({ publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(201)
    expect(inserts[0].requested_period_start).toBe('2026-05-04')
    expect(inserts[0].requested_period_end).toBe('2026-05-10')
    // At insert time they are the same thing; the shrink is what parts them.
    expect(inserts[0].period_start).toBe('2026-05-04')
    expect(inserts[0].period_end).toBe('2026-05-10')
  })

  it('a draft carries it too — approving flips the status, it never re-asks', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC_1 }] })
    projectPublishImpact.mockResolvedValue({ ...UNDER_BUDGET, overBudget: true, overrunEur: 50 })
    const { db, inserts } = buildDb({ publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await publish()
    expect(res.status).toBe(202)
    expect(inserts[0].status).toBe('draft')
    expect(inserts[0].requested_period_start).toBe('2026-05-04')
    expect(inserts[0].requested_period_end).toBe('2026-05-10')
  })
})


// ROSTER-SUPERSEDE.1 — a superseded roster owns no blocks and published
// nothing that is still live. In the default list it reads as a duplicate
// publish over the same dates, which is the confusion superseding removes.
// Hidden by default, never deleted, never unreachable.
describe('GET /api/schedule/rosters — superseded rosters', () => {
  function listDb() {
    const filters = []
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: (c, v) => { filters.push(['eq', c, v]); return chain },
      neq: (c, v) => { filters.push(['neq', c, v]); return chain },
      in: (c, v) => { filters.push(['in', c, v]); return chain },
      then: (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR),
    }
    return { filters, db: { from: () => chain } }
  }

  it('excludes superseded rosters from the default list', async () => {
    const { db, filters } = listDb()
    createServerClient.mockReturnValue(db)
    const res = await GET({ url: `https://x.test/api/schedule/rosters?location_id=${LOC_1}` })
    expect(res.status).toBe(200)
    expect(filters).toContainEqual(['neq', 'status', 'superseded'])
  })

  it('keeps them reachable with an explicit ?status=superseded', async () => {
    const { db, filters } = listDb()
    createServerClient.mockReturnValue(db)
    await GET({ url: `https://x.test/api/schedule/rosters?location_id=${LOC_1}&status=superseded` })
    expect(filters).toContainEqual(['eq', 'status', 'superseded'])
    expect(filters.some((f) => f[0] === 'neq')).toBe(false)
  })

  it('an explicit ?status=draft is unaffected (the approvals queue)', async () => {
    const { db, filters } = listDb()
    createServerClient.mockReturnValue(db)
    await GET({ url: `https://x.test/api/schedule/rosters?location_id=${LOC_1}&status=draft` })
    expect(filters).toContainEqual(['eq', 'status', 'draft'])
    expect(filters.some((f) => f[0] === 'neq')).toBe(false)
  })
})
