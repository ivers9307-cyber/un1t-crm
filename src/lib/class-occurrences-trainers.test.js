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

import { resolveTrainerNames, syncOccurrencesForLocation } from './class-occurrences.js'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-08-04T10:00:00.000Z')
const ID1 = '61a38e7d0cf1970aae0fb3a9'
const ID2 = 'deadbeefdeadbeefdeadbeef'
const ID3 = 'cafebabecafebabecafebabe'

beforeEach(() => {
  fetchUpcomingEvents.mockReset()
  fetchGlofoxTrainers.mockReset().mockResolvedValue([])
  fetchMemberResult.mockReset().mockResolvedValue({ ok: false, member: null })
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
    const out = await resolveTrainerNames(creds({ trainerNames: { [ID1]: 'Jess Murphy' } }), [ID1])
    expect(out).toEqual({ [ID1]: 'Jess Murphy' })
    expect(fetchGlofoxTrainers).not.toHaveBeenCalled()
  })

  it('override keys match case-insensitively (map keys stored lowercase)', async () => {
    const out = await resolveTrainerNames(
      creds({ trainerNames: { [ID1.toUpperCase()]: 'Jess' } }), [ID1])
    expect(out).toEqual({ [ID1]: 'Jess' })
  })

  it('resolves remaining ids via the /2.0/trainers list', async () => {
    fetchGlofoxTrainers.mockResolvedValue([
      { _id: ID1, name: 'Jess Murphy' },
      { _id: ID2, first_name: 'Dan', last_name: 'Byrne' },
    ])
    const out = await resolveTrainerNames(creds(), [ID1, ID2])
    expect(out).toEqual({ [ID1]: 'Jess Murphy', [ID2]: 'Dan Byrne' })
    expect(fetchGlofoxTrainers).toHaveBeenCalledTimes(1)
    expect(fetchMemberResult).not.toHaveBeenCalled()
  })

  it('falls back to /2.0/members per id the list missed', async () => {
    fetchGlofoxTrainers.mockResolvedValue([{ _id: ID1, name: 'Jess' }])
    fetchMemberResult.mockResolvedValue({ ok: true, member: { _id: ID2, first_name: 'Dan' } })
    const out = await resolveTrainerNames(creds(), [ID1, ID2])
    expect(out).toEqual({ [ID1]: 'Jess', [ID2]: 'Dan' })
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
// UPDATE filters are honoured rather than assumed.
function makeDb(tables = {}) {
  const store = { class_occurrences: [], ...tables }
  const calls = { upserts: [], updates: [] }

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

  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null
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
          return true
        }),
      )
    const chain = {
      select() { return chain },
      eq(col, val) { filters.push(['eq', col, val]); return chain },
      neq(col, val) { filters.push(['neq', col, val]); return chain },
      gte(col, val) { filters.push(['gte', col, val]); return chain },
      lte(col, val) { filters.push(['lte', col, val]); return chain },
      in(col, val) { filters.push(['in', col, val]); return chain },
      is(col, val) { filters.push(['is', col, val]); return chain },
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
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: applyFilters(store[table]), error: null }).then(resolve)
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
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Jess Murphy' } }), nowMs: NOW,
    })
    expect(out.ok).toBe(true)
    const row = db._calls.upserts.flatMap((u) => u.rows).find((r) => r.glofox_event_id === 'evt1')
    expect(row.instructor).toBe('Jess Murphy')
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
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Jess Murphy' } }), nowMs: NOW,
    })
    const byId = Object.fromEntries(db._store.class_occurrences.map((r) => [r.glofox_event_id, r]))
    expect(byId['old-1'].instructor).toBe('Jess Murphy')
    expect(byId['old-2'].instructor).toBe('Jess Murphy')
    expect(byId['old-other'].instructor).toBeNull() // different (unmapped) trainer
    expect(byId['too-old'].instructor).toBeNull()   // outside the 35-day backfill window
  })

  it('corrects single-trainer rows when the operator override changes', async () => {
    const db = makeDb({
      class_occurrences: [
        pastOcc('wrong', { daysAgo: 5, instructor: 'J. Murphy' }),
        pastOcc('multi', { daysAgo: 5, instructor: 'J. Murphy, Dan', trainers: [ID1, ID2] }),
      ],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt1', { trainers: [ID1] })] })
    await syncOccurrencesForLocation(db, {
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Jess Murphy' } }), nowMs: NOW,
    })
    const byId = Object.fromEntries(db._store.class_occurrences.map((r) => [r.glofox_event_id, r]))
    expect(byId['wrong'].instructor).toBe('Jess Murphy')
    // Multi-trainer rows are owned by the upsert path (joined names) —
    // the correction UPDATE must not stomp them down to trainers[0].
    expect(byId['multi'].instructor).toBe('J. Murphy, Dan')
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
      locationId: LOC, creds: creds({ trainerNames: { [ID1]: 'Jess' } }), nowMs: NOW,
    })
    expect(out.ok).toBe(false)
    expect(db._store.class_occurrences[0].instructor).toBeNull()
  })
})
