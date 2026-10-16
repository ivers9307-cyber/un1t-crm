// src/lib/tv-idle-content.test.js
//
// TVSCENE.1 — the idle block's data. The stub below RECORDS every builder
// call made on each table, because the filters are the behaviour: a stub that
// ignores `.is()` and `.gte()` would pass whether or not the query excluded a
// cancelled or past class, which is theatre. A board that advertises a
// cancelled class is a real-world failure, so those filters are asserted.
//
// A failed read logs (structurally) AND answers absent: the logger is mocked so
// each failure test can assert both halves of that contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { logWarn } from '@/lib/log'
import {
  buildIdleContent, EARNED_WINDOW_MS, EARNED_LIMIT, UP_NEXT_LIMIT,
  IDLE_LOG_WINDOW_MS, __resetIdleLogThrottle,
  IDLE_CACHE_TTL_MS, UP_NEXT_HORIZON_MS, __resetIdleCache,
} from './tv-idle-content.js'

const ZONE = 'Europe/Dublin'
const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-10-16T04:00:00Z') // 05:00 Dublin, IST
const SUPA = 'https://proj.supabase.co'

// Minimal supabase-shaped stub: each table answers with a canned result and
// records each call (method + args) in `calls[table]`.
//   fail.<table> === true     -> the query resolves { data: null, error }
//   fail.<table> === 'throw'  -> the query itself rejects (the catch path)
// gte/lte are APPLIED, not only recorded, to string-valued columns: a time
// window is the behaviour under test, and a stub that returned every canned row
// whatever the bounds would pass whether or not the query had them. A row whose
// column is not a string (a null start time) is let through, so the code's own
// guard for unreadable rows stays testable. `is`/`eq`/`order`/`limit` are only
// recorded; their tests assert the call.
function dbWith({ occurrences = [], achievements = [], content = null, fail = {} } = {}) {
  const calls = { class_occurrences: [], contact_achievements: [], tv_content: [] }
  const table = (name, rows, mode) => {
    const record = (method) => (...args) => {
      calls[name].push({ method, args })
      return chain
    }
    const bounds = []
    const bound = (method, keep) => (col, value) => {
      calls[name].push({ method, args: [col, value] })
      bounds.push((row) => typeof row[col] !== 'string' || keep(row[col], value))
      return chain
    }
    const visible = () => rows.filter((row) => bounds.every((ok) => ok(row)))
    const errored = () => ({ data: null, error: new Error('boom') })
    const chain = {
      select: record('select'),
      eq: record('eq'),
      gte: bound('gte', (v, min) => v >= min),
      lte: bound('lte', (v, max) => v <= max),
      is: record('is'),
      order: record('order'),
      limit: record('limit'),
      maybeSingle: () => {
        calls[name].push({ method: 'maybeSingle', args: [] })
        if (mode === 'throw') return Promise.reject(new Error('boom'))
        return Promise.resolve(mode ? errored() : { data: visible()[0] ?? null, error: null })
      },
      then: (resolve, reject) => {
        if (mode === 'throw') return reject(new Error('boom'))
        return resolve(mode ? errored() : { data: visible(), error: null })
      },
    }
    return chain
  }
  return {
    calls,
    from: (name) => {
      if (name === 'class_occurrences') return table(name, occurrences, fail.occurrences)
      if (name === 'contact_achievements') return table(name, achievements, fail.achievements)
      if (name === 'tv_content') return table(name, content ? [content] : [], fail.content)
      throw new Error(`unexpected table ${name}`)
    },
  }
}

const opts = (over = {}) => ({ locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW, ...over })

// How many times a table was actually queried (each query selects once).
const reads = (db, table) => db.calls[table].filter((c) => c.method === 'select').length

beforeEach(() => {
  vi.clearAllMocks()
  __resetIdleLogThrottle() // module-level state: every test starts with nothing suppressed
  __resetIdleCache()       // ...and with nothing cached from the last test's database
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPA)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('buildIdleContent — shape', () => {
  it('returns exactly up_next, earned and operator: no counts, no aggregates', async () => {
    const out = await buildIdleContent(dbWith(), opts())
    expect(Object.keys(out).sort()).toEqual(['earned', 'operator', 'up_next'])
  })
})

describe('buildIdleContent — logging', () => {
  it('logs nothing when every read succeeds, including "nothing pushed" and "no display"', async () => {
    await buildIdleContent(dbWith({ occurrences: [{ name: 'A', program: null, starts_at: '2026-10-16T05:00:00Z' }] }), opts())
    await buildIdleContent(dbWith(), opts({ displayId: null }))
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('logs each failed read once, naming the read, the location and the error', async () => {
    const down = { from: () => { throw new Error('client down') } }
    const out = await buildIdleContent(down, opts())
    expect(out).toEqual({ up_next: [], earned: [], operator: null })
    expect(logWarn).toHaveBeenCalledTimes(3)
    const reads = logWarn.mock.calls.map(([, , meta]) => meta.read).sort()
    expect(reads).toEqual(['earned', 'operator', 'up_next'])
    for (const [module, , meta] of logWarn.mock.calls) {
      expect(module).toBe('tv-idle')
      expect(meta).toMatchObject({ locationId: LOC, err: expect.objectContaining({ message: 'client down' }) })
    }
  })

  it('still answers absent when the logger itself throws', async () => {
    logWarn.mockImplementation(() => { throw new Error('cannot serialise') })
    try {
      const out = await buildIdleContent(dbWith({ fail: { occurrences: true, achievements: 'throw', content: true } }), opts())
      expect(out).toEqual({ up_next: [], earned: [], operator: null })
    } finally {
      // Always, so a failed assertion above cannot leak a throwing logger into
      // the tests after it and make them fail for the wrong reason.
      logWarn.mockReset()
    }
  })
})

// A persistent fault is polled every ~4s per kiosk, so an unthrottled log would
// bury the fault in ~130k lines a day. One line per read per location per
// window, carrying how many were held back. Fake timers, never real waits.
describe('buildIdleContent — log throttle', () => {
  const OTHER_LOC = 'b0000000-0000-0000-0000-000000000002'
  const failingUpNext = () => dbWith({ fail: { occurrences: true } })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T04:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('logs two failures of the same read at the same location inside the window once, and both still return absent', async () => {
    const first = await buildIdleContent(failingUpNext(), opts())
    await vi.advanceTimersByTimeAsync(4_000)
    const second = await buildIdleContent(failingUpNext(), opts())
    expect(first.up_next).toEqual([])
    expect(second.up_next).toEqual([])
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][2]).not.toHaveProperty('suppressed')
  })

  it('logs again once the window has passed, carrying how many lines were held back', async () => {
    await buildIdleContent(failingUpNext(), opts())
    await vi.advanceTimersByTimeAsync(IDLE_LOG_WINDOW_MS - 1)
    const inside = await buildIdleContent(failingUpNext(), opts())
    expect(logWarn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const after = await buildIdleContent(failingUpNext(), opts())
    expect(inside.up_next).toEqual([])
    expect(after.up_next).toEqual([])
    expect(logWarn).toHaveBeenCalledTimes(2)
    expect(logWarn.mock.calls[1][2]).toMatchObject({ read: 'up_next', locationId: LOC, suppressed: 1 })
  })

  it('counts the window from the last line emitted, so a suppressed failure never pushes the next report out', async () => {
    await buildIdleContent(failingUpNext(), opts())                      // t0: emitted
    await vi.advanceTimersByTimeAsync(IDLE_LOG_WINDOW_MS - 60_000)
    await buildIdleContent(failingUpNext(), opts())                      // t0+4min: suppressed
    await vi.advanceTimersByTimeAsync(60_000)
    await buildIdleContent(failingUpNext(), opts())                      // t0+5min: due again
    expect(logWarn).toHaveBeenCalledTimes(2)
    expect(logWarn.mock.calls[1][2]).toMatchObject({ suppressed: 1 })
  })

  it('reports the suppressed count once, then starts counting from zero again', async () => {
    await buildIdleContent(failingUpNext(), opts())
    await vi.advanceTimersByTimeAsync(1_000)
    await buildIdleContent(failingUpNext(), opts())
    await buildIdleContent(failingUpNext(), opts())
    await vi.advanceTimersByTimeAsync(IDLE_LOG_WINDOW_MS)
    await buildIdleContent(failingUpNext(), opts())                      // emits, suppressed: 2
    await vi.advanceTimersByTimeAsync(IDLE_LOG_WINDOW_MS)
    await buildIdleContent(failingUpNext(), opts())                      // emits, nothing held back
    expect(logWarn).toHaveBeenCalledTimes(3)
    expect(logWarn.mock.calls[1][2]).toMatchObject({ suppressed: 2 })
    expect(logWarn.mock.calls[2][2]).not.toHaveProperty('suppressed')
  })

  it('throttles different reads independently: one failing read does not silence another', async () => {
    const out1 = await buildIdleContent(dbWith({ fail: { occurrences: true } }), opts())
    // The first call's earned read succeeded, so it is cached. This test is about
    // the log throttle, so make the second call read again.
    __resetIdleCache()
    const out2 = await buildIdleContent(dbWith({ fail: { occurrences: true, achievements: true } }), opts())
    expect(out1.up_next).toEqual([])
    expect(out2).toEqual({ up_next: [], earned: [], operator: null })
    // up_next logged on the first call and was held back on the second; earned
    // had never failed, so its first failure is not held back by up_next's.
    expect(logWarn.mock.calls.map(([, , meta]) => meta.read)).toEqual(['up_next', 'earned'])
  })

  it('throttles the same read at different locations independently', async () => {
    const a = await buildIdleContent(failingUpNext(), opts())
    const b = await buildIdleContent(failingUpNext(), opts({ locationId: OTHER_LOC }))
    const aAgain = await buildIdleContent(failingUpNext(), opts())
    expect([a.up_next, b.up_next, aAgain.up_next]).toEqual([[], [], []])
    expect(logWarn.mock.calls.map(([, , meta]) => meta.locationId)).toEqual([LOC, OTHER_LOC])
  })

  it('throttles a thrown failure the same way as a returned one', async () => {
    const db = () => dbWith({ fail: { achievements: 'throw' } })
    const a = await buildIdleContent(db(), opts())
    const b = await buildIdleContent(db(), opts())
    expect([a.earned, b.earned]).toEqual([[], []])
    expect(logWarn).toHaveBeenCalledTimes(1)
  })
})

describe('buildIdleContent — up_next', () => {
  it('returns occurrences with a studio-zone label, and nothing else about the class', async () => {
    const db = dbWith({ occurrences: [
      { name: 'BU1LD — Strength', program: 'BU1LD', starts_at: '2026-10-16T05:00:00Z' },
      { name: 'The 50+ Club', program: null, starts_at: '2026-10-16T10:00:00Z' },
    ] })
    const out = await buildIdleContent(db, opts())
    expect(out.up_next).toEqual([
      { starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD — Strength', program: 'BU1LD' },
      { starts_at: '2026-10-16T10:00:00Z', starts_at_label: '11:00', class_name: 'The 50+ Club', program: null },
    ])
  })

  // Ruling 2 — the filters are the behaviour, so the query is asserted, not
  // just the rows the stub hands back.
  it('asks only for this studio\'s future, non-cancelled occurrences, soonest first', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    const calls = db.calls.class_occurrences
    expect(calls).toContainEqual({ method: 'eq', args: ['location_id', LOC] })
    expect(calls).toContainEqual({ method: 'is', args: ['cancelled_at', null] })
    expect(calls).toContainEqual({ method: 'gte', args: ['starts_at', new Date(NOW).toISOString()] })
    expect(calls).toContainEqual({ method: 'order', args: ['starts_at', { ascending: true }] })
    expect(calls).toContainEqual({ method: 'limit', args: [UP_NEXT_LIMIT] })
  })

  // The scene prints a bare HH:MM with no day, so it must not reach past a day.
  // The stub applies the bounds, so these assert what the query lets through,
  // and the last one pins the upper bound itself.
  it('leaves out a class more than 24 hours away, and keeps one inside the window', async () => {
    const db = dbWith({ occurrences: [
      { name: 'Tomorrow, same time', program: null, starts_at: new Date(NOW + 23 * 3600_000).toISOString() },
      { name: 'Day after', program: null, starts_at: new Date(NOW + 25 * 3600_000).toISOString() },
    ] })
    const out = await buildIdleContent(db, opts())
    expect(out.up_next.map((o) => o.class_name)).toEqual(['Tomorrow, same time'])
  })

  it('asks for an upper bound of 24 hours from now', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    expect(UP_NEXT_HORIZON_MS).toBe(24 * 60 * 60 * 1000)
    expect(db.calls.class_occurrences).toContainEqual({
      method: 'lte', args: ['starts_at', new Date(NOW + UP_NEXT_HORIZON_MS).toISOString()],
    })
  })

  it('never selects capacity or any booked count', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    const select = db.calls.class_occurrences.find((c) => c.method === 'select').args[0]
    expect(select).not.toMatch(/capacity|booked|headcount|spots/i)
  })

  // Review Focus 2 — Irish summer time ends 2026-10-25.
  it('labels a class on the morning after the DST change in studio local time', async () => {
    const afterDst = Date.parse('2026-10-26T04:00:00Z') // 04:00 Dublin, GMT
    const db = dbWith({ occurrences: [
      { name: 'BU1LD — Strength', program: null, starts_at: '2026-10-26T06:00:00Z' },
    ] })
    const out = await buildIdleContent(db, opts({ nowMs: afterDst }))
    expect(out.up_next[0].starts_at_label).toBe('06:00')
  })

  it('never returns more than UP_NEXT_LIMIT entries', async () => {
    const many = Array.from({ length: UP_NEXT_LIMIT + 4 }, (_, i) => ({
      name: `Class ${i}`, program: null, starts_at: new Date(NOW + (i + 1) * 3600_000).toISOString(),
    }))
    const out = await buildIdleContent(dbWith({ occurrences: many }), opts())
    expect(out.up_next).toHaveLength(UP_NEXT_LIMIT)
  })

  it('drops a row whose start time cannot be read rather than showing a class with no time', async () => {
    const db = dbWith({ occurrences: [
      { name: 'No time', program: null, starts_at: null },
      { name: 'Has time', program: null, starts_at: '2026-10-16T05:00:00Z' },
    ] })
    const out = await buildIdleContent(db, opts())
    expect(out.up_next.map((o) => o.class_name)).toEqual(['Has time'])
  })

  it('is empty, not an error, and logs, when the occurrence read fails', async () => {
    const out = await buildIdleContent(dbWith({ fail: { occurrences: true } }), opts())
    expect(out.up_next).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'up_next', locationId: LOC, err: expect.objectContaining({ message: 'boom' }),
    }))
  })

  it('is empty, not an error, and logs, when the occurrence read throws', async () => {
    const out = await buildIdleContent(dbWith({ fail: { occurrences: 'throw' } }), opts())
    expect(out.up_next).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'up_next', locationId: LOC, err: expect.objectContaining({ message: 'boom' }),
    }))
  })
})

describe('buildIdleContent — earned', () => {
  const row = (over = {}) => ({
    earned_at: '2026-10-15T18:00:00Z',
    metadata: {},
    achievement_rules: { name: '50 classes', tier: 4 },
    contacts: { name: 'Saoirse Murphy', location_id: LOC, hr_leaderboard_opt_out: false },
    ...over,
  })
  const contact = (over = {}) => ({ name: 'Saoirse Murphy', location_id: LOC, hr_leaderboard_opt_out: false, ...over })

  it('renders first name + last initial only', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row()] }), opts())
    expect(out.earned).toEqual([
      { display_name: 'Saoirse M.', achievement: '50 classes', tier: 4, earned_at: '2026-10-15T18:00:00Z' },
    ])
    // The privacy floor, stated as the thing that must not be there.
    const serialised = JSON.stringify(out)
    expect(serialised).not.toContain('Murphy')
    expect(serialised).not.toContain('location_id')
  })

  it('uses the first and LAST word of a multi-part name', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: contact({ name: 'Mary Jane  O\'Brien' }) })] }), opts())
    expect(out.earned[0].display_name).toBe('Mary O.')
  })

  it('uses the bare first name when there is no surname', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: contact({ name: 'Cher' }) })] }), opts())
    expect(out.earned[0].display_name).toBe('Cher')
  })

  it('drops a row with a blank name rather than printing an empty tile', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: contact({ name: '   ' }) })] }), opts())
    expect(out.earned).toEqual([])
  })

  it('drops an opted-out member', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: contact({ name: 'Opt Out', hr_leaderboard_opt_out: true }) })] }), opts())
    expect(out.earned).toEqual([])
  })

  // Review Focus 1 — contact erasure is routine; the join can come back null.
  it('drops a row whose contact no longer resolves', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: null })] }), opts())
    expect(out.earned).toEqual([])
  })

  it('drops a row whose rule no longer resolves', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ achievement_rules: null })] }), opts())
    expect(out.earned).toEqual([])
  })

  it('drops a contact belonging to another studio', async () => {
    const other = contact({ name: 'Hatch Person', location_id: 'b0000000-0000-0000-0000-000000000002' })
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: other })] }), opts())
    expect(out.earned).toEqual([])
  })

  it('looks back over the 7-day window, newest first', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    const calls = db.calls.contact_achievements
    expect(calls).toContainEqual({ method: 'gte', args: ['earned_at', new Date(NOW - EARNED_WINDOW_MS).toISOString()] })
    expect(calls).toContainEqual({ method: 'order', args: ['earned_at', { ascending: false }] })
  })

  it('shows at most EARNED_LIMIT moments, and skipped rows do not use up the limit', async () => {
    const skipped = Array.from({ length: 3 }, () => row({ contacts: contact({ name: 'Hidden Person', hr_leaderboard_opt_out: true }) }))
    const shown = Array.from({ length: EARNED_LIMIT + 3 }, (_, i) => row({ contacts: contact({ name: `Member${i} Smith` }) }))
    const out = await buildIdleContent(dbWith({ achievements: [...skipped, ...shown] }), opts())
    expect(out.earned).toHaveLength(EARNED_LIMIT)
    expect(out.earned[0].display_name).toBe('Member0 S.')
  })

  it('is empty, not an error, and logs, when the achievement read fails', async () => {
    const out = await buildIdleContent(dbWith({ fail: { achievements: true } }), opts())
    expect(out.earned).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'earned', locationId: LOC, err: expect.objectContaining({ message: 'boom' }),
    }))
  })

  it('is empty, not an error, and logs, when the achievement read throws', async () => {
    const out = await buildIdleContent(dbWith({ fail: { achievements: 'throw' } }), opts())
    expect(out.earned).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'earned', locationId: LOC, err: expect.objectContaining({ message: 'boom' }),
    }))
  })
})

// The admin backfill route (api/admin/achievements/[id]/backfill) upserts rows
// with earned_at = now() and metadata.backfilled = true. Left in, months-old
// milestones would read as "earned this week" on a public screen and, being
// newest, fill both the 100-row window and the 5-row display.
describe('buildIdleContent — earned: backfilled grants', () => {
  const backfilled = (name) => ({
    earned_at: '2026-10-16T03:59:00Z',
    metadata: { backfilled: true },
    achievement_rules: { name: '100 classes', tier: 4 },
    contacts: { name, location_id: LOC, hr_leaderboard_opt_out: false },
  })
  const normal = (name) => ({
    earned_at: '2026-10-15T18:00:00Z',
    metadata: {},
    achievement_rules: { name: '50 classes', tier: 3 },
    contacts: { name, location_id: LOC, hr_leaderboard_opt_out: false },
  })

  it('drops a backfilled grant in the window, and a normal one beside it still shows', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [backfilled('Old Milestone'), normal('Real Moment')] }), opts())
    expect(out.earned).toEqual([
      { display_name: 'Real M.', achievement: '50 classes', tier: 3, earned_at: '2026-10-15T18:00:00Z' },
    ])
  })

  it('does not let backfilled grants use up the display limit', async () => {
    const flood = Array.from({ length: EARNED_LIMIT + 3 }, (_, i) => backfilled(`Old${i} Person`))
    const out = await buildIdleContent(dbWith({ achievements: [...flood, normal('Real Moment')] }), opts())
    expect(out.earned.map((e) => e.display_name)).toEqual(['Real M.'])
  })

  // The row check alone would still let a flood of backfilled rows eat the
  // 100-row read, so the query itself must leave them out.
  it('asks the database to leave backfilled grants out, so they cannot fill the 100-row read', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    expect(db.calls.contact_achievements).toContainEqual({ method: 'is', args: ['metadata->>backfilled', null] })
    expect(db.calls.contact_achievements).toContainEqual({ method: 'limit', args: [100] })
  })
})

describe('buildIdleContent — operator', () => {
  const pushed = (over = {}) => ({
    source_type: 'storage', source_ref: 'a.png', label: 'Offer', template_values: null, pushed_at: '2026-10-15T09:00:00Z', ...over,
  })

  // Ruling 1 — a storage row's source_ref is a bucket PATH, not a URL. The
  // Task 1 predicates hand source_ref to an <img src>, so it must arrive resolved.
  it('resolves a storage path to the public bucket URL', async () => {
    const out = await buildIdleContent(dbWith({ content: pushed() }), opts())
    expect(out.operator).toEqual({
      source_type: 'storage',
      source_ref: `${SUPA}/storage/v1/object/public/tv-content/a.png`,
      label: 'Offer',
      template_values: null,
    })
  })

  it('leaves a url row exactly as pushed', async () => {
    const out = await buildIdleContent(dbWith({ content: pushed({ source_type: 'url', source_ref: 'https://example.com/offer.png' }) }), opts())
    expect(out.operator).toEqual({
      source_type: 'url', source_ref: 'https://example.com/offer.png', label: 'Offer', template_values: null,
    })
  })

  it('leaves a template or generated ref alone: it is an id or a key, not an image', async () => {
    const tpl = await buildIdleContent(dbWith({ content: pushed({ source_type: 'template', source_ref: 'tpl-1', template_values: { headline: 'Hi' } }) }), opts())
    expect(tpl.operator).toEqual({ source_type: 'template', source_ref: 'tpl-1', label: 'Offer', template_values: { headline: 'Hi' } })
    const gen = await buildIdleContent(dbWith({ content: pushed({ source_type: 'generated', source_ref: 'sess-9' }) }), opts())
    expect(gen.operator.source_ref).toBe('sess-9')
  })

  // No Supabase URL means no way to build a usable src. Absent beats a
  // broken image held for a full dwell: the label (if any) still draws.
  it('drops the image ref of a storage row, keeps its label, when the project URL is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const out = await buildIdleContent(dbWith({ content: pushed() }), opts())
    expect(out.operator).toEqual({ source_type: 'storage', source_ref: null, label: 'Offer', template_values: null })
  })

  it('treats a blank storage path as no image', async () => {
    const out = await buildIdleContent(dbWith({ content: pushed({ source_ref: '   ' }) }), opts())
    expect(out.operator.source_ref).toBeNull()
  })

  it('reads this display\'s row only', async () => {
    const db = dbWith({ content: pushed() })
    await buildIdleContent(db, opts({ displayId: 'd-42' }))
    expect(db.calls.tv_content).toContainEqual({ method: 'eq', args: ['tv_display_id', 'd-42'] })
  })

  it('is null when nothing is pushed', async () => {
    const out = await buildIdleContent(dbWith({}), opts())
    expect(out.operator).toBeNull()
  })

  it('is null, and reads nothing, when there is no display id', async () => {
    const db = dbWith({ content: pushed({ label: null }) })
    const out = await buildIdleContent(db, opts({ displayId: null }))
    expect(out.operator).toBeNull()
    expect(db.calls.tv_content).toEqual([])
  })

  it('is null, not an error, and logs, when the content read fails', async () => {
    const out = await buildIdleContent(dbWith({ fail: { content: true } }), opts())
    expect(out.operator).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'operator', locationId: LOC, displayId: 'd1', err: expect.objectContaining({ message: 'boom' }),
    }))
  })

  it('is null, not an error, and logs, when the content read throws', async () => {
    const out = await buildIdleContent(dbWith({ fail: { content: 'throw' } }), opts())
    expect(out.operator).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('tv-idle', expect.any(String), expect.objectContaining({
      read: 'operator', locationId: LOC, displayId: 'd1', err: expect.objectContaining({ message: 'boom' }),
    }))
  })
})

// up_next and earned are the two expensive, slow-changing reads (earned scans
// every studio's achievements), cached per location for IDLE_CACHE_TTL_MS. The
// operator read is a primary-key lookup an operator watches, so it is never
// cached. Fake timers: the TTL is clock-driven and a real wait would be slow
// and flaky.
describe('buildIdleContent — read cache', () => {
  const OTHER_LOC = 'b0000000-0000-0000-0000-000000000002'
  const occ = { name: 'Cached Class', program: null, starts_at: '2026-10-16T05:00:00Z' }
  const ach = {
    earned_at: '2026-10-15T18:00:00Z', metadata: {},
    achievement_rules: { name: '50 classes', tier: 4 },
    contacts: { name: 'Saoirse Murphy', location_id: LOC, hr_leaderboard_opt_out: false },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T04:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('serves up_next and earned from the cache inside the TTL, without querying again', async () => {
    const db = dbWith({ occurrences: [occ], achievements: [ach] })
    const first = await buildIdleContent(db, opts())
    await vi.advanceTimersByTimeAsync(IDLE_CACHE_TTL_MS - 1)
    const second = await buildIdleContent(db, opts())
    expect(reads(db, 'class_occurrences')).toBe(1)
    expect(reads(db, 'contact_achievements')).toBe(1)
    expect(second.up_next).toEqual(first.up_next)
    expect(second.earned).toEqual(first.earned)
    expect(second.up_next).toHaveLength(1)
    expect(second.earned).toHaveLength(1)
  })

  it('reads again once the TTL has passed', async () => {
    const db = dbWith({ occurrences: [occ], achievements: [ach] })
    await buildIdleContent(db, opts())
    await vi.advanceTimersByTimeAsync(IDLE_CACHE_TTL_MS)
    await buildIdleContent(db, opts())
    expect(reads(db, 'class_occurrences')).toBe(2)
    expect(reads(db, 'contact_achievements')).toBe(2)
  })

  it('reads the operator row on EVERY call, so a push shows within one poll', async () => {
    const db = dbWith({ content: { source_type: 'url', source_ref: 'https://example.com/a.png', label: 'Offer', template_values: null } })
    await buildIdleContent(db, opts())
    await vi.advanceTimersByTimeAsync(4_000)
    await buildIdleContent(db, opts())
    await buildIdleContent(db, opts())
    expect(reads(db, 'tv_content')).toBe(3)
    // ...while the two cached reads ran once.
    expect(reads(db, 'class_occurrences')).toBe(1)
    expect(reads(db, 'contact_achievements')).toBe(1)
  })

  it('shows a card pushed after the cache was filled on the very next call', async () => {
    const before = await buildIdleContent(dbWith({ occurrences: [occ] }), opts())
    expect(before.operator).toBeNull()
    await vi.advanceTimersByTimeAsync(4_000)
    const pushed = dbWith({ occurrences: [occ], content: { source_type: 'url', source_ref: 'https://example.com/a.png', label: 'Offer', template_values: null } })
    const after = await buildIdleContent(pushed, opts())
    expect(after.operator).toMatchObject({ label: 'Offer' })
    expect(reads(pushed, 'class_occurrences')).toBe(0) // still served from cache
  })

  it('does not cache a failed read: the next call retries instead of serving an empty scene', async () => {
    const failing = dbWith({ fail: { occurrences: true, achievements: true } })
    const a = await buildIdleContent(failing, opts())
    expect(a).toMatchObject({ up_next: [], earned: [] })
    await vi.advanceTimersByTimeAsync(4_000)
    const healthy = dbWith({ occurrences: [occ], achievements: [ach] })
    const b = await buildIdleContent(healthy, opts())
    expect(reads(healthy, 'class_occurrences')).toBe(1)
    expect(reads(healthy, 'contact_achievements')).toBe(1)
    expect(b.up_next).toHaveLength(1)
    expect(b.earned).toHaveLength(1)
  })

  it('does not cache a read that threw either', async () => {
    const throwing = dbWith({ fail: { occurrences: 'throw', achievements: 'throw' } })
    await buildIdleContent(throwing, opts())
    const healthy = dbWith({ occurrences: [occ], achievements: [ach] })
    const out = await buildIdleContent(healthy, opts())
    expect(out.up_next).toHaveLength(1)
    expect(out.earned).toHaveLength(1)
  })

  it('caches a successful EMPTY answer (nothing coming up is an answer, not a failure)', async () => {
    const db = dbWith()
    await buildIdleContent(db, opts())
    await buildIdleContent(db, opts())
    expect(reads(db, 'class_occurrences')).toBe(1)
    expect(reads(db, 'contact_achievements')).toBe(1)
  })

  it('keeps one entry per location: another studio never gets this studio\'s rows', async () => {
    const a = dbWith({ occurrences: [occ], achievements: [ach] })
    await buildIdleContent(a, opts())
    const b = dbWith({ occurrences: [{ ...occ, name: 'Other Studio Class' }] })
    const out = await buildIdleContent(b, opts({ locationId: OTHER_LOC }))
    expect(reads(b, 'class_occurrences')).toBe(1)
    expect(reads(b, 'contact_achievements')).toBe(1)
    expect(out.up_next.map((o) => o.class_name)).toEqual(['Other Studio Class'])
    expect(out.earned).toEqual([])
    // and this studio's entry is still its own
    const again = await buildIdleContent(a, opts())
    expect(again.up_next.map((o) => o.class_name)).toEqual(['Cached Class'])
    expect(reads(a, 'class_occurrences')).toBe(1)
  })

  it('shares an entry between two kiosks of one studio (keyed on location, not display)', async () => {
    const db = dbWith({ occurrences: [occ], achievements: [ach] })
    await buildIdleContent(db, opts({ displayId: 'd1' }))
    await buildIdleContent(db, opts({ displayId: 'd2' }))
    expect(reads(db, 'class_occurrences')).toBe(1)
    expect(reads(db, 'contact_achievements')).toBe(1)
  })

  it('hands every caller its own copy: mutating a result cannot change what the next caller gets', async () => {
    const db = dbWith({ occurrences: [occ], achievements: [ach] })
    const first = await buildIdleContent(db, opts())     // the miss
    first.up_next.push({ class_name: 'Injected' })
    first.up_next[0].class_name = 'Mutated'
    first.earned[0].display_name = 'Mutated'
    first.earned.length = 0
    const second = await buildIdleContent(db, opts())    // a hit
    expect(second.up_next.map((o) => o.class_name)).toEqual(['Cached Class'])
    expect(second.earned.map((e) => e.display_name)).toEqual(['Saoirse M.'])
    second.up_next[0].class_name = 'Mutated again'
    second.earned.pop()
    const third = await buildIdleContent(db, opts())     // another hit
    expect(third.up_next.map((o) => o.class_name)).toEqual(['Cached Class'])
    expect(third.earned.map((e) => e.display_name)).toEqual(['Saoirse M.'])
    expect(reads(db, 'class_occurrences')).toBe(1)
  })

  it('still logs a failed read once, then retries without re-logging inside the log window', async () => {
    await buildIdleContent(dbWith({ fail: { occurrences: true } }), opts())
    await vi.advanceTimersByTimeAsync(4_000)
    await buildIdleContent(dbWith({ fail: { occurrences: true } }), opts())
    expect(logWarn).toHaveBeenCalledTimes(1)
  })
})

describe('buildIdleContent — fail to absent', () => {
  it('returns an empty block, never a rejection, when the client itself throws', async () => {
    const down = { from: () => { throw new Error('client down') } }
    const out = await buildIdleContent(down, opts())
    expect(out).toEqual({ up_next: [], earned: [], operator: null })
  })
})
