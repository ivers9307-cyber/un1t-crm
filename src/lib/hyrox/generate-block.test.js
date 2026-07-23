import { describe, it, expect } from 'vitest'
import { expandBlockWeek, summarizePrevWeek } from './generate-block'

const goodSessionText = JSON.stringify({
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine', is_benchmark: false,
  full_session: { warmup: 'w', main: 'm', cues: [], why: 'y' },
  board: {
    location_label: 'X', week_label: 'W5', focus: 'ENGINE', format: '4 RFT', cap_minutes: 45,
    stations: [{ name: 'Run', performance: '400m', elite: '500m' }], target: 'sub-32',
  },
})

const block = {
  id: 'b1', location_id: 'loc1', sessions_per_week: 2, difficulty_dial: 'mixed',
  arc: { plan: [{ week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'add a round', is_benchmark: false }] },
}

// Minimal fake supabase-js: the idempotency select chain resolves to `existing`;
// upsert captures the rows + options it's given and returns them via .select().
// The prev-week query chains .select().eq().eq().order() — order() resolves to
// an empty list so prevWeekSummary is null/empty and existing expandBlockWeek
// tests are unaffected.
function fakeDb({ existing = [] } = {}) {
  const inserted = []
  let upsertOpts = null
  return {
    inserted,
    get upsertOpts() { return upsertOpts },
    from() {
      return {
        select() { return this },
        eq() { return this },
        limit() { return Promise.resolve({ data: existing }) },
        order() { return Promise.resolve({ data: [] }) },
        upsert(rows, opts) {
          upsertOpts = opts
          inserted.push(...rows)
          return { select: () => Promise.resolve({ data: rows.map((_, i) => ({ id: `new-${i}` })), error: null }) }
        },
      }
    },
  }
}

const okCaller = async () => ({ ok: true, text: goodSessionText })

describe('expandBlockWeek', () => {
  it('skips a week that already has sessions (idempotent)', async () => {
    const db = fakeDb({ existing: [{ id: 's-existing' }] })
    const out = await expandBlockWeek(db, { block, weekNo: 5, charter: 'c', caller: okCaller })
    expect(out).toMatchObject({ ok: true, sessionsCreated: 0, skipped: true })
    expect(db.inserted).toHaveLength(0)
  })

  it('generates one session per slot in parallel and inserts them as drafts', async () => {
    const db = fakeDb({ existing: [] })
    const calls = []
    const caller = async (args) => { calls.push(args); return { ok: true, text: goodSessionText } }
    const out = await expandBlockWeek(db, { block, weekNo: 5, charter: 'c', caller })
    expect(out).toMatchObject({ ok: true, sessionsCreated: 2 })
    expect(calls).toHaveLength(2)
    expect(db.inserted).toHaveLength(2)
    expect(db.inserted[0]).toMatchObject({ block_id: 'b1', location_id: 'loc1', week_no: 5, status: 'draft' })
  })

  it('errors when the arc has no such week', async () => {
    const out = await expandBlockWeek(fakeDb(), { block, weekNo: 9, charter: 'c', caller: okCaller })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('no_arc_week')
  })

  it('fails cleanly (no insert) when no session generates', async () => {
    const db = fakeDb({ existing: [] })
    const badCaller = async () => ({ ok: true, text: 'not json at all' })
    const out = await expandBlockWeek(db, { block, weekNo: 5, charter: 'c', caller: badCaller })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('session_generation_failed')
    expect(db.inserted).toHaveLength(0)
  })

  it('inserts race-safely via upsert on the unique key (ignore duplicates)', async () => {
    const db = fakeDb({ existing: [] })
    const out = await expandBlockWeek(db, { block, weekNo: 5, charter: 'c', caller: okCaller })
    expect(out.ok).toBe(true)
    expect(db.upsertOpts).toEqual({ onConflict: 'block_id,week_no,slot', ignoreDuplicates: true })
  })
})

describe('summarizePrevWeek', () => {
  it('joins each session\'s slot, focus, and format into one line', () => {
    const sessions = [
      { slot: 1, focus: 'Engine', board: { format: '4 RFT' } },
      { slot: 2, focus: 'Strength', board: { format: 'EMOM' } },
    ]
    expect(summarizePrevWeek(sessions)).toBe('session 1: Engine (4 RFT); session 2: Strength (EMOM)')
  })

  it('omits the format when board.format is missing', () => {
    expect(summarizePrevWeek([{ slot: 1, focus: 'Engine', board: {} }])).toBe('session 1: Engine')
  })

  it('returns null for an empty list', () => {
    expect(summarizePrevWeek([])).toBeNull()
  })

  it('returns null when no sessions have a focus', () => {
    expect(summarizePrevWeek([{ slot: 1, focus: null, board: {} }])).toBeNull()
  })

  it('returns null for a non-array input', () => {
    expect(summarizePrevWeek(undefined)).toBeNull()
  })
})
