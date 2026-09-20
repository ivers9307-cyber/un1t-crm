// ROSTER-FIX.4 — POST /api/schedule/rosters/[id]/approve.
//
// Approving IS publishing: the flip to status='published' is followed by the
// same block tagging POST /api/schedule/rosters does. So it has to run the
// same overlap guard. A draft can sit in the approvals queue for days while
// somebody publishes a roster over the same dates; approving it then created
// exactly the two-published-rosters-over-one-day state the POST guard exists
// to prevent, and the block tagging silently stole the other roster's days.
//
// The permission check also moved ABOVE the draft/published branch (reject
// already did it that way): under it, a caller with no rosters permission got
// a 409 naming the roster's status on a non-draft and a 403 otherwise, which
// answered "is this id a draft awaiting approval?" for anyone with an id.
//
// The guard itself (which overlaps are legitimate) is unit-tested in
// src/lib/roster-publish.test.js; these tests run the REAL helper so the
// wiring — including excludeRosterId — is what is under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// getUserLocationIds is the real one-liner from @/lib/auth — mocking it away
// would make the cross-tenant 404 untestable, which is the point of it.
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (user) => (user?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
// BUDGETAPPROVE.1 — only the projection is stubbed; the overlap / supersede
// helpers stay REAL, as before. projectionChanged stays real too.
vi.mock('@/lib/roster-publish', async (importOriginal) => ({
  ...(await importOriginal()),
  projectPublishImpact: vi.fn(),
}))
// ROSTERTIDY.1 — spied so a remnant-supersede failure can be shown to LOG
// rather than fail the approval.
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))
vi.mock('@/lib/roster-notify', () => ({
  notifyStaffOfPublish: vi.fn(() => Promise.resolve()),
  publishNotifyRowsForBlocks: vi.fn(() => Promise.resolve([])),
  renotifyChangedCoaches: vi.fn(() => Promise.resolve({ notified: 0 })),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { notifyStaffOfPublish, renotifyChangedCoaches } = await import('@/lib/roster-notify')
const { projectPublishImpact } = await import('@/lib/roster-publish')
const { logWarn } = await import('@/lib/log')
const { POST } = await import('./route.js')

const FRESH = {
  monthStart: '2026-05-01', monthEnd: '2026-05-31', monthlyBudgetEur: 5000,
  alreadyPublishedEur: 4400, periodProjectedEur: 689.95, monthProjectedTotalEur: 5089.95,
  remainingEur: -89.95, overBudget: true, overrunEur: 89.95, blockCount: 7,
  months: [],
}

const PROPS = { params: Promise.resolve({ id: 'roster-1' }) }

function draft(overrides = {}) {
  return {
    id: 'roster-1',
    location_id: 'loc-1',
    status: 'draft',
    period_start: '2026-05-04',
    period_end: '2026-05-10',
    created_by: 'manager-1',
    published_by: null,
    ...overrides,
  }
}

// Per-table mock. `rosters` serves three different queries: the roster fetch
// (select('*') … .single()), the overlap probe (a narrow select that is
// awaited), and the status flip. The probe's filters are recorded so the
// self-exclusion can be asserted.
function buildDb({ roster, publishedRosters = [], updateError = null, updateThrows = null, captureError = null, tagError = null, rosterUpdateError = null, blockCounts = {}, blockDates = {}, applyUpdates = false }) {
  const updates = []
  const probe = []
  const blockUpdates = []
  const db = {
    from(table) {
      if (table === 'rosters') {
        return {
          select(cols) {
            if (cols === '*') {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: roster,
                    error: roster ? null : { message: 'no rows' },
                  }),
                }),
              }
            }
            // ROSTER-TRIM.1 — the DATE and ID filters are applied, so the
            // OVERLAP probe and the CONTAINMENT probe (the release) can no
            // longer be confused for one another: a straddling roster the
            // release would never select must not come back from it.
            // status/location_id are not filtered; the fixtures omit them and
            // those filters are asserted by name instead.
            const filters = []
            const DATE_OR_ID = new Set(['period_start', 'period_end', 'id'])
            const matches = (r) => filters.every(([op, col, val]) => {
              // ROSTERTIDY.1 — a row an applyUpdates test superseded carries a
              // status; fixtures without one still match every status filter.
              if (col === 'status' && r.status && op === 'eq') return r.status === val
              if (!DATE_OR_ID.has(col)) return true
              if (op === 'eq') return r[col] === val
              if (op === 'neq') return r[col] !== val
              if (op === 'lte') return r[col] <= val
              if (op === 'gte') return r[col] >= val
              return true
            })
            const record = (op) => (c, v) => { probe.push([op, c, v]); filters.push([op, c, v]); return chain }
            const chain = {
              eq: record('eq'),
              lte: record('lte'),
              gte: record('gte'),
              neq: record('neq'),
              then: (onF, onR) => Promise.resolve({ data: publishedRosters.filter(matches), error: null }).then(onF, onR),
            }
            return chain
          },
          update(payload) {
            // ROSTER-SUPERSEDE.1 — rosters now takes four shapes of UPDATE:
            // the status flip (.eq().select().single()), the superseded_by
            // stamp (.select('id') read back), and the release / restore
            // writes, which are awaited directly.
            const rec = { payload, where: [], afterFlip: updates.some((u) => u.payload.status === 'published') }
            updates.push(rec)
            // ROSTER-TRIM.1 — a per-payload failure hook, so a test can break
            // the RELEASE (status: 'superseded') while letting the trim land.
            const payloadErr = rosterUpdateError ? rosterUpdateError(payload) : null
            // ROSTERTIDY.1 — opt-in: land a successful update on the fixture
            // row, so a trimmed roster reads back with its TRIMMED period.
            // Without it the phase-2 sweep still sees the pre-trim period and
            // settles the remnant itself, which on real data it never could.
            if (applyUpdates) {
              queueMicrotask(() => {
                if (payloadErr) return
                const id = rec.where.find(([c]) => c === 'id')?.[1]
                const row = publishedRosters.find((r) => r.id === id)
                if (row) Object.assign(row, payload)
              })
            }
            const w = {
              eq: (c, v) => { rec.where.push([c, v]); return w },
              in: (c, v) => { rec.where.push([c, v]); return w },
              is: (c, v) => { rec.where.push([c, v]); return w },
              select: () => ({
                // updateThrows is the failure an error object cannot describe:
                // a PostgREST 5xx, a dropped fetch, a function timeout.
                single: () => (updateThrows
                  ? Promise.reject(new Error(updateThrows))
                  : Promise.resolve({
                    data: updateError ? null : { ...roster, ...payload },
                    error: updateError,
                  })),
                then: (onF, onR) => {
                  const targeted = rec.where.find(([c]) => c === 'id')?.[1]
                  const ids = Array.isArray(targeted) ? targeted : [targeted].filter(Boolean)
                  return Promise.resolve({
                    data: payloadErr ? null : ids.map((id) => ({ id })),
                    error: payloadErr,
                  }).then(onF, onR)
                },
              }),
              then: (onF, onR) => Promise.resolve({ data: null, error: payloadErr }).then(onF, onR),
            }
            return w
          },
        }
      }
      if (table === 'shift_blocks') {
        // One builder serves both shift_blocks queries — the newly-published
        // capture (a select) and the tagging (an update) — so the resolved
        // error has to follow whichever one this chain turned into.
        let isUpdate = false
        // ROSTERTIDY.1 — the owned-block recount is a head:true count by
        // roster_id; answered from `blockCounts`.
        // FINALTIDY.1 — `blockDates` (roster id → block dates) answers the
        // count AND the first/last block_date reads ownedBlockRange makes;
        // `blockCounts` alone still answers a bare count.
        let head = false
        let rosterId = null
        let asc = true
        const ownedCount = (id) => (blockDates[id] ? blockDates[id].length : blockCounts[id] || 0)
        const chain = {
          select: (_c, opts) => { head = !!opts?.head; return chain },
          update: (payload) => { isUpdate = true; blockUpdates.push(payload); return chain },
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
                ? { data: null, count: ownedCount(rosterId), error: null }
                : { data: [], error: captureError },
          ).then(onF, onR),
        }
        return chain
      }
      throw new Error('unexpected table: ' + table)
    },
  }
  return { db, updates, probe, blockUpdates }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  hasPermissionForLocation.mockReset()
  hasPermissionForLocation.mockReturnValue(true)
  projectPublishImpact.mockReset()
  projectPublishImpact.mockResolvedValue(FRESH)
  notifyStaffOfPublish.mockClear()
  renotifyChangedCoaches.mockClear()
  getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
})

describe('POST /api/schedule/rosters/[id]/approve — overlap guard', () => {
  it('refuses a draft week that sits INSIDE a since-published month, changing nothing', async () => {
    const month = { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }
    const { db, updates, blockUpdates } = buildDb({ roster: draft(), publishedRosters: [month] })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    const body = await res.json()
    // Same shape the publish route returns, so the modal renders one thing.
    expect(body.error).toBe('overlapping_roster')
    expect(body.overlapping).toEqual([month])
    expect(updates).toHaveLength(0)
    expect(blockUpdates).toHaveLength(0)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })

  // ROSTER-TRIM.1 — approving IS publishing, so it resolves a one-sided
  // straddle the same way the publish route does: trim the older roster back
  // to the days it keeps, before the draft to published flip.
  it('trims a published roster that straddles the edge, and approves', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const trim = updates.find((u) => u.payload.period_end === '2026-05-03')
    expect(trim.payload).toEqual({ period_start: '2026-04-27', period_end: '2026-05-03' })
    expect(trim.where).toContainEqual(['id', 'r-prev'])
  })

  // ROSTERTIDY.1 — after the approval the trimmed r-prev keeps only 27 Apr to
  // 3 May, all in the PAST, so whether it survives turns on whether it still
  // OWNS a block there, recounted after the re-tag.
  function isRemnantSupersede(u) {
    return u.payload.status === 'superseded' && u.payload.superseded_by === 'roster-1'
      && u.where.some(([c, v]) => c === 'id' && v === 'r-prev')
  }
  // FINALTIDY.1 — the post-flip shrink: a period write narrowed by the
  // TRIMMED period (the trim itself is narrowed by the pre-trim period).
  function isRemnantShrink(u) {
    return u.afterFlip && 'period_start' in u.payload && !('status' in u.payload)
      && u.where.some(([c, v]) => c === 'id' && v === 'r-prev')
  }

  it('keeps a trimmed remnant that still owns a block', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
      // Blocks on both ends of the trimmed 27 Apr - 3 May: full coverage.
      blockDates: { 'r-prev': ['2026-04-27', '2026-05-03'] },
      applyUpdates: true,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates.some(isRemnantSupersede)).toBe(false)
    expect(updates.some(isRemnantShrink)).toBe(false)
  })

  it('supersedes a past trimmed remnant left owning zero blocks, AFTER the flip', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
      blockCounts: {},
      applyUpdates: true,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    // Exactly one — from the remnant check, not the sweep (which can no
    // longer see the trimmed row).
    const sups = updates.filter(isRemnantSupersede)
    expect(sups).toHaveLength(1)
    const [sup] = sups
    expect(sup.afterFlip).toBe(true)
    expect(sup.where).toContainEqual(['period_start', '2026-04-27'])
    expect(sup.where).toContainEqual(['period_end', '2026-05-03'])
  })

  it('a failed remnant supersede only logs — the approval still succeeds, with no warning', async () => {
    logWarn.mockClear()
    const { db } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
      rosterUpdateError: (payload) => (payload.superseded_by === 'roster-1' ? { message: 'deadlock' } : null),
      applyUpdates: true,
    })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning || '').not.toMatch(/deadlock/)
    expect(logWarn).toHaveBeenCalledWith('rosters/approve', 'trimmed roster could not be superseded or shrunk', expect.objectContaining({
      err: expect.stringMatching(/r-prev: deadlock/), roster_id: 'roster-1',
    }))
  })

  // FINALTIDY.1 — a past remnant that still owns blocks, but on fewer days
  // than its trimmed period, is shrunk to the days it owns. "Today" is pinned
  // so the past/future split never depends on the clock.
  describe('partly-empty trimmed remnant (fixed today 18 Sep 2026)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-09-18T12:00:00Z'))
    })
    afterEach(() => { vi.useRealTimers() })

    it('shrinks a PAST remnant with empty days to its first/last owned block, after the flip', async () => {
      const { db, updates } = buildDb({
        roster: draft(),
        publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
        // Trimmed to 27 Apr - 3 May; owns blocks only 28 - 30 Apr.
        blockDates: { 'r-prev': ['2026-04-28', '2026-04-30'] },
        applyUpdates: true,
      })
      createServerClient.mockReturnValue(db)
      const res = await POST({}, PROPS)
      expect(res.status).toBe(200)
      expect(updates.some(isRemnantSupersede)).toBe(false)
      const shrinks = updates.filter(isRemnantShrink)
      expect(shrinks).toHaveLength(1)
      const [shrink] = shrinks
      expect(shrink.payload).toEqual({ period_start: '2026-04-28', period_end: '2026-04-30' })
      // requested_period_* (the operator's original ask) is never rewritten.
      expect(Object.keys(shrink.payload)).not.toContain('requested_period_start')
      // Compare-and-swap on published + the TRIMMED period.
      expect(shrink.where).toEqual([
        ['id', 'r-prev'], ['status', 'published'],
        ['period_start', '2026-04-27'], ['period_end', '2026-05-03'],
      ])
    })

    it('leaves a LIVE remnant alone (reaching today or later), and logs it', async () => {
      logWarn.mockClear()
      const { db, updates } = buildDb({
        roster: draft({ period_start: '2026-09-01', period_end: '2026-09-20' }),
        // Straddles the END: trimmed to 21 - 27 Sep, which is after today.
        publishedRosters: [{ id: 'r-next', period_start: '2026-09-14', period_end: '2026-09-27' }],
        blockDates: { 'r-next': ['2026-09-22'] },
        applyUpdates: true,
      })
      createServerClient.mockReturnValue(db)
      const res = await POST({}, PROPS)
      expect(res.status).toBe(200)
      const afterFlip = updates.filter((u) => u.afterFlip && u.where.some(([c, v]) => c === 'id' && v === 'r-next'))
      expect(afterFlip).toHaveLength(0)
      expect(logWarn).toHaveBeenCalledWith('rosters/approve', expect.stringMatching(/trimmed roster kept/), expect.objectContaining({
        trimmed_ids: ['r-next'], roster_id: 'roster-1',
      }))
    })

    it('a failed shrink only logs; the approval still succeeds', async () => {
      logWarn.mockClear()
      const { db } = buildDb({
        roster: draft(),
        publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
        blockDates: { 'r-prev': ['2026-04-28', '2026-04-30'] },
        rosterUpdateError: (payload) => (payload.period_end === '2026-04-30' ? { message: 'deadlock' } : null),
        applyUpdates: true,
      })
      createServerClient.mockReturnValue(db)
      const res = await POST({}, PROPS)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.warning || '').not.toMatch(/deadlock/)
      expect(logWarn).toHaveBeenCalledWith('rosters/approve', 'trimmed roster could not be superseded or shrunk', expect.objectContaining({
        err: expect.stringMatching(/period shrink failed for trimmed roster r-prev: deadlock/), roster_id: 'roster-1',
      }))
    })
  })

  // 🔴 THE RELEASE RUNS AFTER THE TRIM, so its refusal is no longer free: a
  // trimmed roster left behind by an approval that never happened owns blocks
  // outside its own period (mig 602's pre-apply check (c2)).
  it('puts a trimmed roster back when standing down the replaced rosters fails', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [
        { id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' },
        { id: 'r-inner', period_start: '2026-05-06', period_end: '2026-05-08' },
      ],
      rosterUpdateError: (payload) => (payload.status === 'superseded' ? { message: 'lock timeout' } : null),
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/lock timeout/)
    // Never flipped, and the trim was undone.
    expect(updates.some((u) => u.payload.status === 'published')).toBe(false)
    const restore = updates.at(-1)
    expect(restore.payload).toEqual({ period_start: '2026-04-27', period_end: '2026-05-05' })
    expect(restore.where).toContainEqual(['id', 'r-prev'])
  })

  it('names the period that would work when a published roster engulfs the draft', async () => {
    const { db } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.suggested_period).toEqual({ start: '2026-05-01', end: '2026-05-31' })
  })

  it('approves a draft that CONTAINS the published roster — the wider one takes over', async () => {
    const { db, updates } = buildDb({
      roster: draft({ period_start: '2026-05-01', period_end: '2026-05-31' }),
      publishedRosters: [{ id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // ROSTER-SUPERSEDE.1 — the flip is no longer the only write: the week it
    // swallows is stood down first, and stamped with its successor after.
    expect(updates[0].payload.status).toBe('superseded')
    expect(updates.some((u) => u.payload.status === 'published')).toBe(true)
  })

  it('approves normally when nothing overlaps, and excludes the draft from its own guard', async () => {
    const { db, updates, probe } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates[0].payload).toMatchObject({ status: 'published', over_budget_approval_by: 'owner-1' })
    // Without this the roster would collide with itself the moment the check
    // ever ran against a row that is already published.
    expect(probe).toContainEqual(['neq', 'id', 'roster-1'])
    expect(probe).toContainEqual(['eq', 'status', 'published'])
    expect(probe).toContainEqual(['eq', 'location_id', 'loc-1'])
  })

  it('re-notifies coaches whose published shifts changed, as a plain publish does (NOTIFY.1)', async () => {
    const { db } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(renotifyChangedCoaches).toHaveBeenCalledWith(db, { locationId: 'loc-1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
  })
})

describe('POST /api/schedule/rosters/[id]/approve — gate ordering', () => {
  it('checks permission BEFORE the draft/published branch: a published roster gives 403, not 409', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager', locations: [{ id: 'loc-1' }] })
    hasPermissionForLocation.mockReturnValue(false)
    const { db, updates } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    // 409 here would leak that this id exists and what state it is in.
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('checks permission BEFORE the overlap branch too: a conflicting draft gives 403', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('a permitted caller on an already-published roster still gets the 409', async () => {
    const { db, updates } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already published/)
    expect(updates).toHaveLength(0)
  })

  it('unknown roster id → 404', async () => {
    const { db } = buildDb({ roster: null })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(404)
  })

  it('no session → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(401)
  })

  it('a failed status flip surfaces as 400 and never notifies staff', async () => {
    const { db } = buildDb({ roster: draft(), updateError: { message: 'constraint violation' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(400)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
    expect(renotifyChangedCoaches).not.toHaveBeenCalled()
  })
})

describe('POST /api/schedule/rosters/[id]/approve — cross-tenant posture', () => {
  it('a caller at another location gets 404, not 403: the id must look missing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-3', role: 'manager', locations: [{ id: 'loc-2' }] })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Roster not found')
    expect(updates).toHaveLength(0)
    // The location check runs FIRST — a permission answer would already be
    // an answer about a roster the caller may not know exists.
    expect(hasPermissionForLocation).not.toHaveBeenCalled()
  })

  it('master is not location-scoped and still approves', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', role: 'master', locations: [] })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates[0].payload.status).toBe('published')
  })

  it('an at-location caller without the rosters permission still gets 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager', locations: [{ id: 'loc-1' }] })
    hasPermissionForLocation.mockReturnValue(false)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/schedule/rosters/[id]/approve — block errors are not swallowed', () => {
  it('a failed newly-published capture still approves and still tags, but is logged', async () => {
    const { db, updates, blockUpdates } = buildDb({ roster: draft(), captureError: { message: 'read timeout' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The approval is done; only the notify set was lost.
    expect(updates[0].payload.status).toBe('published')
    expect(blockUpdates).toHaveLength(1)
  })

  it('a failed tagging returns a partial success naming it, and notifies nobody', async () => {
    const { db, updates } = buildDb({ roster: draft(), tagError: { message: 'deadlock detected' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Same shape POST /api/schedule/rosters uses: the roster IS published,
    // so this is a warning on a success, not a failure.
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('published')
    expect(body.warning).toMatch(/block tagging failed: deadlock detected/)
    expect(updates).toHaveLength(1)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })
})


// ROSTER-SUPERSEDE.1 — approving IS publishing, so it resolves the overlaps
// it is allowed to create the same way POST does. Mig 602's exclusion
// constraint judges the draft→published UPDATE exactly as it judges an
// INSERT, so the swallowed rosters are stood down BEFORE the flip.
describe('POST /api/schedule/rosters/[id]/approve — supersede', () => {
  it('stands the swallowed roster down BEFORE the flip, then stamps the successor', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)

    const release = updates.find((u) => u.payload.status === 'superseded')
    expect(release).toBeTruthy()
    expect(release.afterFlip).toBe(false)
    expect(release.payload.superseded_by).toBeNull()

    const stamp = updates.find((u) => u.payload.superseded_by === 'roster-1')
    expect(stamp).toBeTruthy()
    expect(stamp.afterFlip).toBe(true)
  })

  it('excludes the draft itself from its own release set', async () => {
    const { db, probe } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)
    await POST({}, PROPS)
    // Both the overlap guard and the release narrow by neq id.
    expect(probe.filter((f) => f[0] === 'neq' && f[2] === 'roster-1').length).toBeGreaterThanOrEqual(2)
  })

  it('puts the released rosters back when the flip fails', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      updateError: { message: 'constraint violation' },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(400)
    expect(updates.at(-1).payload).toEqual({ status: 'published', superseded_at: null, superseded_by: null })
  })

  it('puts them back when the status flip THROWS instead of returning an error', async () => {
    // 🔴 The failure the error-object branch cannot see: a PostgREST 5xx, a
    // dropped fetch, the function timing out. Unwrapped, the throw escaped the
    // route with the swallowed rosters already stood down, and they stayed
    // superseded FOREVER — a coach's published week gone on a transient blip.
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      updateThrows: 'fetch failed',
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/fetch failed/)
    expect(updates.at(-1).payload).toEqual({ status: 'published', superseded_at: null, superseded_by: null })
    expect(updates.at(-1).where).toContainEqual(['id', ['r-same']])
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })

  it('warns that the stood-down rosters are stranded when tagging fails', async () => {
    const { db } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }],
      tagError: { message: 'deadlock detected' },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    const body = await res.json()
    expect(body.warning).toMatch(/deadlock detected/)
    expect(body.warning).toMatch(/read as unpublished/)
  })
})

// BUDGETAPPROVE.1 — approval re-runs the projection. The stored figures are a
// snapshot from when the manager hit publish (drafts have waited 218 hours),
// so the sign-off has to be recorded against the numbers as they stand now.
describe('POST /api/schedule/rosters/[id]/approve — re-projection', () => {
  it('re-projects the roster\'s own location and period, and stores the fresh figures on the flip', async () => {
    const { db, updates } = buildDb({ roster: draft({ projected_contractor_eur: 689.95, budget_at_publish_eur: 5000 }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    // COPYLEAVE.1 — an approval shows no advisory lists, so it asks for none
    // (no sibling-location or other-studio read on the approval path).
    expect(projectPublishImpact).toHaveBeenCalledWith(db, { locationId: 'loc-1', periodStart: '2026-05-04', periodEnd: '2026-05-10', advisories: false })
    const flip = updates.find((u) => u.payload.status === 'published')
    expect(flip.payload).toMatchObject({ projected_contractor_eur: 689.95, budget_at_publish_eur: 5000 })

    const body = await res.json()
    expect(body.impact).toEqual(FRESH)
    expect(body.projection_changed).toBe(false)
    expect(body.previous_projection).toBeUndefined()
  })

  it('a stale snapshot is flagged with BOTH figures, and the approval still goes through', async () => {
    // Numeric columns come back from PostgREST as strings.
    const { db, updates } = buildDb({ roster: draft({ projected_contractor_eur: '99.96', budget_at_publish_eur: '5000' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    // The approver is the budget authority: a moved number never refuses.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.projection_changed).toBe(true)
    expect(body.previous_projection).toEqual({ projected_contractor_eur: 99.96, budget_at_publish_eur: 5000 })
    expect(body.current_projection).toEqual({ projected_contractor_eur: 689.95, budget_at_publish_eur: 5000 })
    expect(updates.find((u) => u.payload.status === 'published').payload.projected_contractor_eur).toBe(689.95)
  })

  it('re-projects AFTER the gates: a refused caller never costs a projection', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
    expect(projectPublishImpact).not.toHaveBeenCalled()
  })

  it('a projection that throws does not block the approval and leaves the stored figures alone', async () => {
    projectPublishImpact.mockRejectedValue(new Error('Block lookup failed: timeout'))
    const { db, updates } = buildDb({ roster: draft({ projected_contractor_eur: 99.96, budget_at_publish_eur: 5000 }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const flip = updates.find((u) => u.payload.status === 'published')
    expect(flip.payload).not.toHaveProperty('projected_contractor_eur')
    const body = await res.json()
    expect(body.projection_changed).toBe(false)
    expect(body.projection_error).toMatch(/timeout/)
  })
})

// BUDGETAPPROVE.1 — approver authority resolves at the ROSTER's location. Run
// the REAL permission resolver here: the mocked one answers whatever it is
// told, which is how a wrong-studio lookup would sail through.
describe('POST /api/schedule/rosters/[id]/approve — approver role at the roster\'s studio', () => {
  async function realPermission() {
    const actual = await vi.importActual('@/lib/permissions')
    hasPermissionForLocation.mockImplementation(actual.hasPermissionForLocation)
  }

  it('an owner at another studio who is head coach at the roster\'s studio is refused', async () => {
    await realPermission()
    // Active studio is loc-2, where they own it, so user.role reads 'owner'.
    getCurrentUser.mockResolvedValue({
      id: 'split-1', role: 'owner', profileRole: 'head_coach',
      locations: [{ id: 'loc-1', role: 'head_coach' }, { id: 'loc-2', role: 'owner' }],
      rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'owner' },
      assignmentsByLocation: {
        'loc-1': { role: 'head_coach', permissions: {} },
        'loc-2': { role: 'owner', permissions: {} },
      },
      roleTemplatesByLocation: {},
    })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('the same person approves at the studio they own, whatever studio is active', async () => {
    await realPermission()
    getCurrentUser.mockResolvedValue({
      id: 'split-2', role: 'head_coach', profileRole: 'head_coach',
      locations: [{ id: 'loc-1', role: 'owner' }, { id: 'loc-2', role: 'head_coach' }],
      rolesByLocation: { 'loc-1': 'owner', 'loc-2': 'head_coach' },
      assignmentsByLocation: {
        'loc-1': { role: 'owner', permissions: {} },
        'loc-2': { role: 'head_coach', permissions: {} },
      },
      roleTemplatesByLocation: {},
    })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates.find((u) => u.payload.status === 'published').payload.over_budget_approval_by).toBe('split-2')
  })
})
