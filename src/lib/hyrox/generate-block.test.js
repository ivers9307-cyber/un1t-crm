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

// Minimal fake supabase-js. expandBlockWeek makes up to two ordered reads in a
// fixed order: (1) the slots already stored for THIS week (per-slot idempotency),
// then (2) last week's sessions for the prev-week summary (only when weekNo > 1).
// order() resolves the first call to `existing` and the second to `prev`. upsert
// captures the rows + options it's given and echoes ids back via .select().
function fakeDb({ existing = [], prev = [] } = {}) {
  const inserted = []
  let upsertOpts = null
  let orderCalls = 0
  return {
    inserted,
    get upsertOpts() { return upsertOpts },
    from() {
      return {
        select() { return this },
        eq() { return this },
        order() {
          orderCalls += 1
          return Promise.resolve({ data: orderCalls === 1 ? existing : prev })
        },
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
  it('skips a week whose every slot already exists (idempotent)', async () => {
    const db = fakeDb({ existing: [{ slot: 1 }, { slot: 2 }] })
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

  it('generates ONLY the missing slots when a week is partially filled (recovery)', async () => {
    const db = fakeDb({ existing: [{ slot: 1 }] }) // slot 1 landed, slot 2 failed last time
    const calls = []
    const caller = async (args) => { calls.push(args); return { ok: true, text: goodSessionText } }
    const out = await expandBlockWeek(db, { block, weekNo: 5, charter: 'c', caller })
    expect(out).toMatchObject({ ok: true, sessionsCreated: 1 })
    expect(calls).toHaveLength(1)
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ week_no: 5, slot: 2, status: 'draft' })
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
