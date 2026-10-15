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
import { buildIdleContent, EARNED_WINDOW_MS, EARNED_LIMIT, UP_NEXT_LIMIT } from './tv-idle-content.js'

const ZONE = 'Europe/Dublin'
const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-10-16T04:00:00Z') // 05:00 Dublin, IST
const SUPA = 'https://proj.supabase.co'

// Minimal supabase-shaped stub: each table answers with a canned result and
// records each call (method + args) in `calls[table]`.
//   fail.<table> === true     -> the query resolves { data: null, error }
//   fail.<table> === 'throw'  -> the query itself rejects (the catch path)
function dbWith({ occurrences = [], achievements = [], content = null, fail = {} } = {}) {
  const calls = { class_occurrences: [], contact_achievements: [], tv_content: [] }
  const table = (name, rows, mode) => {
    const record = (method) => (...args) => {
      calls[name].push({ method, args })
      return chain
    }
    const errored = () => ({ data: null, error: new Error('boom') })
    const chain = {
      select: record('select'),
      eq: record('eq'),
      gte: record('gte'),
      lte: record('lte'),
      is: record('is'),
      order: record('order'),
      limit: record('limit'),
      maybeSingle: () => {
        calls[name].push({ method: 'maybeSingle', args: [] })
        if (mode === 'throw') return Promise.reject(new Error('boom'))
        return Promise.resolve(mode ? errored() : { data: rows[0] ?? null, error: null })
      },
      then: (resolve, reject) => {
        if (mode === 'throw') return reject(new Error('boom'))
        return resolve(mode ? errored() : { data: rows, error: null })
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

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPA) })
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
    const out = await buildIdleContent(dbWith({ fail: { occurrences: true, achievements: 'throw', content: true } }), opts())
    expect(out).toEqual({ up_next: [], earned: [], operator: null })
    logWarn.mockReset()
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

describe('buildIdleContent — fail to absent', () => {
  it('returns an empty block, never a rejection, when the client itself throws', async () => {
    const down = { from: () => { throw new Error('client down') } }
    const out = await buildIdleContent(down, opts())
    expect(out).toEqual({ up_next: [], earned: [], operator: null })
  })
})
