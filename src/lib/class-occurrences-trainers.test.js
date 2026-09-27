// STUDIO-KPI.4 — trainer-name resolution + instructor backfill.
//
// resolveTrainerNames: operator overrides (settings.glofox.trainer_names,
// carried on creds) → /2.0/trainers list → per-id /2.0/members fallback,
// all best-effort. syncOccurrencesForLocation: upserted rows carry the
// mapped instructor, and PAST rows (which the [now, +48h] window never
// revisits — the scorecard reads 28 days of history) are backfilled /
// corrected by bounded UPDATEs keyed on raw->trainers->>0.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const fetchUpcomingEvents = vi.fn()
const fetchGlofoxTrainers = vi.fn()
const fetchMemberResult = vi.fn()
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchUpcomingEvents: (...a) => fetchUpcomingEvents(...a),
  fetchGlofoxTrainers: (...a) => fetchGlofoxTrainers(...a),
  fetchMemberResult: (...a) => fetchMemberResult(...a),
}))

import {
  resolveTrainerNames,
  resolveTrainerNamesWithStats,
  readSpineTrainerNames,
  isTrainerLookupTick,
  syncOccurrencesForLocation,
} from './class-occurrences.js'
import { logError } from '@/lib/log'
import { dublinDateKey } from '@/lib/dublin-time'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-08-04T10:00:00.000Z')
const ID1 = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const ID2 = 'aaaaaaaaaaaaaaaaaaaaaaa2'
const ID3 = 'aaaaaaaaaaaaaaaaaaaaaaa3'

beforeEach(() => {
  fetchUpcomingEvents.mockReset()
  fetchGlofoxTrainers.mockReset().mockResolvedValue([])
  fetchMemberResult.mockReset().mockResolvedValue({ ok: false, member: null })
  logError.mockClear()
})

const creds = (extra = {}) => ({ branchId: 'b', apiKey: 'k', apiToken: 't', ...extra })

// ── resolveTrainerNames ────────────────────────────────────────────

describe('resolveTrainerNames', () => {
  it('returns {} for no ids without touching the API', async () => {
    expect(await resolveTrainerNames(creds(), [])).toEqual({})
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
    expect(fetchMemberResult).not.toHaveBeenCalled()
  })

  it('operator overrides win and skip the API entirely', async () => {
    const out = await resolveTrainerNames(creds({ trainerNames: { [ID1]: 'Coach One' } }), [ID1])
    expect(out).toEqual({ [ID1]: 'Coach One' })
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  it('override keys match case-insensitively (map keys stored lowercase)', async () => {
    const out = await resolveTrainerNames(
      creds({ trainerNames: { [ID1.toUpperCase()]: 'Coach One' } }), [ID1])
    expect(out).toEqual({ [ID1]: 'Coach One' })
  })

  it('resolves remaining ids via the /2.0/trainers list', async () => {
    fetchGlofoxTrainers.mockResolvedValue([
      { _id: ID1, name: 'Coach One' },
      { _id: ID2, first_name: 'Coach', last_name: 'Two' },
    ])
    const out = await resolveTrainerNames(creds(), [ID1, ID2])
    expect(out).toEqual({ [ID1]: 'Coach One', [ID2]: 'Coach Two' })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).not.toHaveBeenCalled()
  })

  it('falls back to /2.0/members per id the list missed', async () => {
    fetchGlofoxTrainers.mockResolvedValue([{ _id: ID1, name: 'Coach One' }])
    fetchMemberResult.mockResolvedValue({ ok: true, member: { _id: ID2, first_name: 'Coach', last_name: 'Two' } })
    const out = await resolveTrainerNames(creds(), [ID1, ID2])
    expect(out).toEqual({ [ID1]: 'Coach One', [ID2]: 'Coach Two' })
    expect(fetchMemberResult).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).toHaveBeenCalledWith(expect.anything(), ID2)
  })

  it('leaves unresolvable ids out of the map (instructor stays null)', async () => {
    const out = await resolveTrainerNames(creds(), [ID3])
    expect(out).toEqual({})
  })

  it('caps member-endpoint fallback lookups per run', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(22)}`)
    await resolveTrainerNames(creds(), ids)
    expect(fetchMemberResult).toHaveBeenCalledTimes(10)
  })
})

// ── sync: instructor on upsert + past-row backfill ─────────────────

// In-memory Supabase fake. Extends the class-climate-runner harness with
// neq + JSON-path column resolution (raw->trainers->>N) so the backfill
// UPDATE filters are honoured rather than assumed. TRAINERCALLS.1: a select
// now PROJECTS its column list (incl. PostgREST's `alias:json->path`), so a
// reader that selects `trainer_id:raw->trainers->>0` gets `trainer_id` back
// exactly as it would from PostgREST; `.not(col,'is',null)` is honoured; and
// a select or upsert can be made to fail.
function makeDb(tables = {}, { failSelect = null, failUpsert = false } = {}) {
  const store = { class_occurrences: [], ...tables }
  const calls = { upserts: [], updates: [], selects: [] }

  const colValue = (row, col) => {
    if (!col.includes('->')) return row[col]
    let cur = row
    for (const part of col.split(/->>?/)) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[/^\d+$/.test(part) ? Number(part) : part]
    }
    if (cur == null) return null
    return typeof cur === 'object' ? cur : String(cur)
  }

  const project = (row, cols) => {
    if (typeof cols !== 'string' || !cols.trim() || cols.trim() === '*') return row
    const out = {}
    for (const part of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':')
      const [alias, path] = i > 0 ? [part.slice(0, i), part.slice(i + 1)] : [part, part]
      out[alias] = colValue(row, path)
    }
    return out
  }

  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null
    let cols = null
    const applyFilters = (rows) =>
      rows.filter((r) =>
        filters.every(([kind, col, val]) => {
          const v = colValue(r, col)
          if (kind === 'eq') return v === val
          if (kind === 'neq') return v != null && v !== val
          if (kind === 'gte') return v != null && v >= val
          if (kind === 'lte') return v != null && v <= val
          if (kind === 'in') return val.includes(v)
          if (kind === 'is') return val === null ? v == null : v === val
          if (kind === 'not_is') return val === null ? v != null : v !== val
          return true
        }),
      )
    const chain = {
      select(c) { cols = c ?? null; return chain },
      eq(col, val) { filters.push(['eq', col, val]); return chain },
      neq(col, val) { filters.push(['neq', col, val]); return chain },
      gte(col, val) { filters.push(['gte', col, val]); return chain },
      lte(col, val) { filters.push(['lte', col, val]); return chain },
      in(col, val) { filters.push(['in', col, val]); return chain },
      is(col, val) { filters.push(['is', col, val]); return chain },
      not(col, operator, val) { filters.push([`not_${operator}`, col, val]); return chain },
      order() { return chain },
      limit() { return chain },
      update(patch) { op = 'update'; payload = patch; return chain },
      upsert(rows, options) { op = 'upsert'; payload = { rows, options }; calls.upserts.push({ table, rows, options }); return chain },
      then(resolve) {
        if (op === 'update') {
          const matched = applyFilters(store[table])
          for (const r of matched) Object.assign(r, payload)
          calls.updates.push({ table, patch: payload, matched: matched.length, filters: [...filters] })
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        if (op === 'upsert') {
          return Promise.resolve({ data: null, error: failUpsert ? { message: 'upsert failed' } : null }).then(resolve)
        }
        calls.selects.push({ table, cols, filters: [...filters] })
        if (failSelect && failSelect(table, cols)) {
          return Promise.resolve({ data: null, error: { message: 'select failed' } }).then(resolve)
        }
        return Promise.resolve({ data: applyFilters(store[table]).map((r) => project(r, cols)), error: null }).then(resolve)
      },
    }
    return chain
  }
  return { from: (t) => builder(t), _store: store, _calls: calls }
}

const glofoxEvent = (id, { trainers, startOffsetMin = 60 } = {}) => ({
  _id: id,
  name: 'Strength 45',
  time_start: Math.floor((NOW + startOffsetMin * 60_000) / 1000),
  duration: 45,
  active: true,
  ...(trainers ? { trainers } : {}),
})

const pastOcc = (id, { daysAgo = 5, instructor = null, trainers = [ID1] } = {}) => ({
  glofox_event_id: id,
  location_id: LOC,
  name: 'Strength 45',
  starts_at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  ends_at: new Date(NOW - daysAgo * 86_400_000 + 45 * 60_000).toISOString(),
  cancelled_at: null,
  instructor,
  raw: { _id: id, trainers },
})

describe('syncOccurrencesForLocation: trainer-name mapping + backfill', () => {
  it('upserts future rows with the mapped instructor', async () => {
    const db = makeDb()
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    const out = await syncOccurrencesForLocation(db, {
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Coach One' } }), nowMs: NOW,
    })
    expect(out.ok).toBe(true)
    const row = db._calls.upserts.flatMap((u) => u.rows).find((r) => r.glofox_event_id === 'evt1')
    expect(row.instructor).toBe('Coach One')
  })

  it('backfills PAST rows whose instructor is null from raw.trainers[0]', async () => {
    const db = makeDb({
      class_occurrences: [
        pastOcc('old-1', { daysAgo: 5 }),
        pastOcc('old-2', { daysAgo: 20 }),
        pastOcc('old-other', { daysAgo: 5, trainers: [ID2] }),
        pastOcc('too-old', { daysAgo: 60 }),
      ],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    await syncOccurrencesForLocation(db, {
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Coach One' } }), nowMs: NOW,
    })
    const byId = Object.fromEntries(db._store.class_occurrences.map((r) => [r.glofox_event_id, r]))
    expect(byId['old-1'].instructor).toBe('Coach One')
    expect(byId['old-2'].instructor).toBe('Coach One')
    expect(byId['old-other'].instructor).toBeNull() // different (unmapped) trainer
    expect(byId['too-old'].instructor).toBeNull()   // outside the 35-day backfill window
  })

  it('corrects single-trainer rows when the operator override changes', async () => {
    const db = makeDb({
      class_occurrences: [
        pastOcc('wrong', { daysAgo: 5, instructor: 'C. One' }),
        pastOcc('multi', { daysAgo: 5, instructor: 'C. One, Coach Two', trainers: [ID1, ID2] }),
      ],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    await syncOccurrencesForLocation(db, {
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Coach One' } }), nowMs: NOW,
    })
    const byId = Object.fromEntries(db._store.class_occurrences.map((r) => [r.glofox_event_id, r]))
    expect(byId['wrong'].instructor).toBe('Coach One')
    // Multi-trainer rows are owned by the upsert path (joined names) —
    // the correction UPDATE must not stomp them down to trainers[0].
    expect(byId['multi'].instructor).toBe('C. One, Coach Two')
  })

  it('runs no backfill when nothing resolves (unmapped ids stay null, no updates fire)', async () => {
    const db = makeDb({ class_occurrences: [pastOcc('old-1', { daysAgo: 5 })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID3] })] })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: NOW })
    expect(out.ok).toBe(true)
    expect(db._store.class_occurrences[0].instructor).toBeNull()
    const instructorUpdates = db._calls.updates.filter((u) => 'instructor' in (u.patch || {}))
    expect(instructorUpdates).toHaveLength(0)
  })

  it('a failed fetch backfills nothing', async () => {
    const db = makeDb({ class_occurrences: [pastOcc('old-1', { daysAgo: 5 })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: false, status: 502, body: {} })
    const out = await syncOccurrencesForLocation(db, {
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Coach One' } }), nowMs: NOW,
    })
    expect(out.ok).toBe(false)
    expect(db._store.class_occurrences[0].instructor).toBeNull()
  })
})

// ── TRAINERCALLS.1 — Glofox is asked for trainer names once a day ──
//
// Live on 27 Sep 2026: instructor NULL on 647/647 rows, no override
// anywhere, and every 15-minute tick spent 1 /2.0/trainers call plus one
// /2.0/members call per trainer id in the window (4), each answered
// "200 success:false, Resource not available": ~480 futile calls a day.
// The lookup now runs on the tick in [04:00, 04:15) Dublin; every other tick
// uses overrides (free) and the names the spine already holds for ids that
// lead a single-trainer class. A multi-trainer-only id has no memory (pinned
// below; CLASSLINK.1 inherits it).

// 04:05 Dublin (IST) on 4 Aug: the daily lookup tick. NOW (11:00 IST) is not.
const DAY_TICK = Date.parse('2026-08-04T03:05:00.000Z')

describe('isTrainerLookupTick', () => {
  it.each([
    ['2026-08-04T03:00:00.000Z', true, '04:00 IST, the tick itself'],
    ['2026-08-04T03:00:40.000Z', true, '04:00 IST + Vercel jitter'],
    ['2026-08-04T03:14:59.000Z', true, 'last second of the window'],
    ['2026-08-04T03:15:00.000Z', false, 'the 04:15 tick is outside'],
    ['2026-08-04T04:05:00.000Z', false, '05:05 IST: the UTC 04:00 hour is not Dublin 04:00 in summer'],
    ['2026-12-01T04:05:00.000Z', true, '04:05 GMT in winter'],
    ['2026-12-01T03:05:00.000Z', false, '03:05 GMT'],
    ['2026-10-25T04:05:00.000Z', true, 'clocks-back day, after the change: 04:05 GMT'],
    ['2026-10-25T03:05:00.000Z', false, 'clocks-back day: 03:05 GMT'],
    ['2026-03-29T03:05:00.000Z', true, 'clocks-forward day, after the change: 04:05 IST'],
  ])('%s → %s (%s)', (iso, expected) => {
    expect(isTrainerLookupTick(Date.parse(iso))).toBe(expected)
  })

  it('an unreadable instant is never a lookup tick', () => {
    expect(isTrainerLookupTick(NaN)).toBe(false)
    expect(isTrainerLookupTick(undefined)).toBe(false)
  })

  it('exactly one */15 tick per Dublin day lands in the window, every day of 2026 (both DST days included)', () => {
    const perDay = new Map()
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 15 * 60_000) {
      const key = dublinDateKey(t + 25_000) // stamps land ~25 s after the minute
      if (!perDay.has(key)) perDay.set(key, 0)
      if (isTrainerLookupTick(t + 25_000)) perDay.set(key, perDay.get(key) + 1)
    }
    expect(perDay.size).toBe(365)
    expect([...perDay.values()].every((n) => n === 1)).toBe(true)
  }, 20_000) // 35,040 Intl formats; dublinTimeLabel builds a formatter per call
})

describe('readSpineTrainerNames (the names the spine already holds)', () => {
  const OTHER_LOC = 'b0000000-0000-0000-0000-000000000002'
  const OTHER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa9'

  it('returns the newest single-trainer label per id inside the 35-day window', async () => {
    const db = makeDb({
      class_occurrences: [
        pastOcc('a-old', { daysAgo: 20, instructor: 'Coach Old', trainers: [ID1] }),
        pastOcc('a-new', { daysAgo: 2, instructor: 'Coach A', trainers: [ID1] }),
        pastOcc('multi', { daysAgo: 1, instructor: 'Coach A, Coach B', trainers: [ID1, ID2] }), // multi-trainer: not one person's name
        pastOcc('unnamed', { daysAgo: 1, instructor: null, trainers: [ID2] }),
        pastOcc('ancient', { daysAgo: 60, instructor: 'Coach Gone', trainers: [ID3] }), // outside 35 days
        pastOcc('not-asked', { daysAgo: 1, instructor: 'Coach C', trainers: [OTHER_ID] }), // not in this window's ids
        { ...pastOcc('elsewhere', { daysAgo: 1, instructor: 'Coach D', trainers: [ID2] }), location_id: OTHER_LOC },
      ],
    })
    const out = await readSpineTrainerNames(db, { locationId: LOC, trainerIds: [ID1, ID2, ID3], nowMs: NOW })
    expect(out).toEqual({ names: { [ID1]: 'Coach A' }, error: null })
  })

  it('a failed read is an error, never "no names"', async () => {
    const db = makeDb({}, { failSelect: (t) => t === 'class_occurrences' })
    const out = await readSpineTrainerNames(db, { locationId: LOC, trainerIds: [ID1], nowMs: NOW })
    expect(out.names).toEqual({})
    expect(out.error).toMatchObject({ message: 'select failed' })
  })

  it('asks nothing when there are no ids', async () => {
    const db = makeDb()
    expect(await readSpineTrainerNames(db, { locationId: LOC, trainerIds: [], nowMs: NOW })).toEqual({ names: {}, error: null })
    expect(db._calls.selects).toHaveLength(0)
  })
})

describe('resolveTrainerNamesWithStats', () => {
  it('lookup:false asks Glofox nothing; overrides and known names still apply', async () => {
    const out = await resolveTrainerNamesWithStats(
      creds({ trainerNames: { [ID1]: 'Coach A' } }), [ID1, ID2, ID3], { lookup: false, known: { [ID2]: 'Coach B' } })
    expect(out).toEqual({ names: { [ID1]: 'Coach A', [ID2]: 'Coach B' }, apiCalls: 0 })
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
    expect(fetchMemberResult).not.toHaveBeenCalled()
  })

  it('on a lookup, Glofox beats a known name, an override beats both, and a known name fills what Glofox left', async () => {
    fetchGlofoxTrainers.mockResolvedValue([{ _id: ID2, name: 'Coach B Renamed' }, { _id: ID1, name: 'Coach A (Glofox)' }])
    const out = await resolveTrainerNamesWithStats(
      creds({ trainerNames: { [ID1]: 'Coach A' } }), [ID1, ID2, ID3],
      { lookup: true, known: { [ID1]: 'Coach Old', [ID2]: 'Coach B', [ID3]: 'Coach C' } })
    expect(out.names).toEqual({ [ID1]: 'Coach A', [ID2]: 'Coach B Renamed', [ID3]: 'Coach C' })
  })

  it('counts every Glofox request it attempts: the list once, then one per id it still lacks (the live "Resource not available" answer names nobody)', async () => {
    fetchMemberResult.mockResolvedValue({ ok: true, member: { success: false, message_code: 'Resource not available, empty result cant be processed' } })
    const out = await resolveTrainerNamesWithStats(creds(), [ID1, ID2, ID3])
    expect(out).toEqual({ names: {}, apiCalls: 4 })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).toHaveBeenCalledTimes(3)
  })

  it('resolveTrainerNames with no options still asks Glofox live (the settings tab check is unchanged)', async () => {
    await resolveTrainerNames(creds(), [ID1])
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).toHaveBeenCalledTimes(1)
  })
})

describe('syncOccurrencesForLocation: Glofox is asked for trainer names once a day', () => {
  const threeTrainers = () => [
    glofoxEvent('evt1', { trainers: [ID1] }),
    glofoxEvent('evt2', { trainers: [ID2], startOffsetMin: 120 }),
    glofoxEvent('evt3', { trainers: [ID3], startOffsetMin: 180 }),
  ]
  const upserted = (db, id) => db._calls.upserts.flatMap((u) => u.rows).find((r) => r.glofox_event_id === id)

  it('an ordinary tick makes NO trainer-name call to Glofox', async () => {
    const db = makeDb()
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: threeTrainers() })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: NOW })
    expect(out).toMatchObject({ ok: true, upserted: 3, trainerLookup: 'skipped', trainerApiCalls: 0 })
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
    expect(fetchMemberResult).not.toHaveBeenCalled()
  })

  it('the 04:00 Dublin tick asks exactly as before: the list once, then each id', async () => {
    const db = makeDb()
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: threeTrainers() })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: DAY_TICK })
    expect(out).toMatchObject({ ok: true, trainerLookup: 'daily', trainerApiCalls: 4 })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).toHaveBeenCalledTimes(3)
  })

  it('a whole Dublin day of */15 ticks makes ONE lookup (4 calls), not 96 (384)', async () => {
    const dayStart = Date.parse('2026-08-03T23:00:00.000Z') // 00:00 IST, 4 Aug
    let lookups = 0
    for (let i = 0; i < 96; i++) {
      fetchUpcomingEvents.mockResolvedValue({ ok: true, events: threeTrainers() })
      const out = await syncOccurrencesForLocation(makeDb(), { locationId: LOC, creds: creds(), nowMs: dayStart + i * 15 * 60_000 + 25_000 })
      if (out.trainerLookup === 'daily') lookups++
    }
    expect(lookups).toBe(1)
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).toHaveBeenCalledTimes(3)
  })

  it('an ordinary tick reuses a name the spine holds for an id that leads a single-trainer class (no flap to NULL between lookups)', async () => {
    const db = makeDb({ class_occurrences: [pastOcc('old-1', { daysAgo: 5, instructor: 'Coach A', trainers: [ID1] })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: NOW })
    expect(upserted(db, 'evt1').instructor).toBe('Coach A')
    expect(out).toMatchObject({ trainerLookup: 'skipped', trainerApiCalls: 0 })
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  // KNOWN LIMITATION (review of TRAINERCALLS.1, option (a) chosen): the spine
  // memory keys on raw.trainers[0] of SINGLE-trainer rows, so an id that only
  // ever appears in multi-trainer classes is never remembered. On a non-lookup
  // tick its name drops out of the joined label ("A, B" becomes "A") until the
  // next 04:00 Dublin lookup names it again, and past multi-trainer rows keep
  // whatever label they already had. Latent today (no trainer is named at
  // all). CLASSLINK.1 inherits this; if it adds a per-id identity source, this
  // test is the one to flip.
  it('KNOWN LIMITATION: a multi-trainer-only id gets no remembered name on a non-lookup tick', async () => {
    const db = makeDb({
      class_occurrences: [
        pastOcc('solo', { daysAgo: 3, instructor: 'Coach A', trainers: [ID1] }),
        pastOcc('pair', { daysAgo: 2, instructor: 'Coach A, Coach B', trainers: [ID1, ID2] }),
      ],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1, ID2] })] })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: NOW })
    expect(out).toMatchObject({ ok: true, trainerLookup: 'skipped', trainerApiCalls: 0 })
    const spine = await readSpineTrainerNames(db, { locationId: LOC, trainerIds: [ID1, ID2], nowMs: NOW })
    expect(spine.names).toEqual({ [ID1]: 'Coach A' }) // ID2 has no memory
    expect(upserted(db, 'evt1').instructor).toBe('Coach A') // "Coach A, Coach B" lost its second name
    expect(db._store.class_occurrences.find((r) => r.glofox_event_id === 'pair').instructor).toBe('Coach A, Coach B')
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  it('a lookup tick where Glofox names nobody keeps the spine name', async () => {
    const db = makeDb({ class_occurrences: [pastOcc('old-1', { daysAgo: 5, instructor: 'Coach A', trainers: [ID1] })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: DAY_TICK })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(upserted(db, 'evt1').instructor).toBe('Coach A')
  })

  it('an operator override applies at once, on any tick, and corrects past rows (unchanged)', async () => {
    const db = makeDb({ class_occurrences: [pastOcc('old-1', { daysAgo: 5, instructor: 'Coach A', trainers: [ID1] })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Coach B' } }), nowMs: NOW })
    expect(upserted(db, 'evt1').instructor).toBe('Coach B')
    expect(db._store.class_occurrences.find((r) => r.glofox_event_id === 'old-1').instructor).toBe('Coach B')
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  it('a failed spine read asks Glofox this tick (main\'s behaviour, never louder) and logs it', async () => {
    const db = makeDb({}, { failSelect: (t, cols) => t === 'class_occurrences' && String(cols).includes('instructor') })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: threeTrainers() })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: NOW })
    expect(out).toMatchObject({ ok: true, upserted: 3, trainerLookup: 'fallback', trainerApiCalls: 4 })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'class-occurrences',
      expect.stringMatching(/spine trainer-name read failed/),
      expect.objectContaining({ locationId: LOC, error: 'select failed' }),
    )
  })

  it('events with no trainer ids read nothing and ask nothing', async () => {
    const db = makeDb()
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1')] })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: DAY_TICK })
    expect(out).toMatchObject({ ok: true, trainerLookup: 'none', trainerApiCalls: 0 })
    expect(db._calls.selects.filter((s) => String(s.cols).includes('instructor'))).toHaveLength(0)
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  it('an upsert failure still reports the Glofox calls the tick made', async () => {
    const db = makeDb({}, { failUpsert: true })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: threeTrainers() })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds: creds(), nowMs: DAY_TICK })
    expect(out).toMatchObject({ ok: false, error: 'upsert failed', upserted: 0, trainerLookup: 'daily', trainerApiCalls: 4 })
  })
})
