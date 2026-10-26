import { describe, it, expect, vi } from 'vitest'
import { clampBatch, shouldRecordFor, recordUsageBatch } from './ingest.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const H = 3600_000

function batch({ start = NOW - 10 * MIN, end = NOW, visits } = {}) {
  return {
    session: { id: 's1', platform: 'web', app_version: null, started_at: iso(start), ended_at: iso(end) },
    visits: visits || [{ id: 'v1', feature: 'contacts', started_at: iso(start), ended_at: iso(end) }],
  }
}

describe('clampBatch', () => {
  it('pulls a future end back to now + 2 min', () => {
    const b = clampBatch(batch({ end: NOW + 3 * H }), NOW)
    expect(b.session.ended_at).toBe(iso(NOW + 2 * MIN))
    expect(b.visits[0].ended_at).toBe(iso(NOW + 2 * MIN))
  })

  it('drops a batch whose session ended more than 48 h ago', () => {
    expect(clampBatch(batch({ start: NOW - 72 * H, end: NOW - 71 * H }), NOW)).toBeNull()
  })

  it('pulls a long-running session start up to 48 h ago', () => {
    const b = clampBatch(batch({ start: NOW - 72 * H, end: NOW }), NOW)
    expect(b.session.started_at).toBe(iso(NOW - 48 * H))
  })

  it('trims a visit into its session', () => {
    const b = clampBatch(batch({ visits: [{ id: 'v', feature: 'inbox', started_at: iso(NOW - H), ended_at: iso(NOW + H) }] }), NOW)
    expect(b.visits[0]).toMatchObject({ started_at: iso(NOW - 10 * MIN), ended_at: iso(NOW) })
  })

  it('caps a visit at 4 h', () => {
    const b = clampBatch(batch({
      start: NOW - 6 * H,
      visits: [{ id: 'v', feature: 'inbox', started_at: iso(NOW - 6 * H), ended_at: iso(NOW) }],
    }), NOW)
    expect(Date.parse(b.visits[0].ended_at) - Date.parse(b.visits[0].started_at)).toBe(4 * H)
  })

  it('drops a visit that falls wholly outside its session', () => {
    const b = clampBatch(batch({ visits: [{ id: 'v', feature: 'inbox', started_at: iso(NOW - 3 * H), ended_at: iso(NOW - 2 * H) }] }), NOW)
    expect(b.visits).toEqual([])
  })

  it('swaps nothing and drops a session that ends before it starts', () => {
    expect(clampBatch(batch({ start: NOW, end: NOW - MIN }), NOW)).toBeNull()
  })
})

describe('shouldRecordFor', () => {
  const staff = { id: 'p1', profileRole: 'staff', isMaster: false }
  it('records an ordinary staff member', () => expect(shouldRecordFor(staff)).toBe(true))
  it('never records a missing user', () => expect(shouldRecordFor(null)).toBe(false))
  it('never records a master', () => expect(shouldRecordFor({ ...staff, profileRole: 'master', isMaster: true })).toBe(false))
  it('never records a view-as session', () => expect(shouldRecordFor({ ...staff, impersonatingFrom: { id: 'm' } })).toBe(false))
  it('never records a support session', () => expect(shouldRecordFor({ ...staff, supportSession: { mode: 'read' } })).toBe(false))
})

function makeDb({ existing = null, readError = null, sessionError = null, visitError = null } = {}) {
  const calls = []
  const db = {
    from(table) {
      const b = {
        select(cols) { calls.push(['select', table, cols]); return b },
        eq(col, val) { calls.push(['eq', table, col, val]); return b },
        maybeSingle() { return Promise.resolve({ data: existing, error: readError }) },
        upsert(rows, opts) {
          calls.push(['upsert', table, rows, opts])
          const error = table === 'app_usage_sessions' ? sessionError : visitError
          return Promise.resolve({ data: null, error })
        },
      }
      return b
    },
  }
  return { db, calls }
}

describe('recordUsageBatch', () => {
  const args = (db) => ({ db, profileId: 'p1', locationId: 'loc1', batch: batch(), nowMs: NOW })

  it('upserts the session then the visits, stamped with the caller', async () => {
    const { db, calls } = makeDb()
    const res = await recordUsageBatch(args(db))
    expect(res).toEqual({ recorded: true, visits: 1 })
    const upserts = calls.filter((c) => c[0] === 'upsert')
    expect(upserts.map((c) => c[1])).toEqual(['app_usage_sessions', 'app_usage_visits'])
    expect(upserts[0][2]).toMatchObject({ id: 's1', profile_id: 'p1', location_id: 'loc1', platform: 'web' })
    expect(upserts[0][3]).toEqual({ onConflict: 'id' })
    expect(upserts[1][2][0]).toMatchObject({ id: 'v1', session_id: 's1', profile_id: 'p1', feature: 'contacts' })
  })

  it('keeps the session studio from the first batch on a re-send', async () => {
    const { db, calls } = makeDb({ existing: { profile_id: 'p1', location_id: 'loc-first' } })
    await recordUsageBatch(args(db))
    const session = calls.find((c) => c[0] === 'upsert' && c[1] === 'app_usage_sessions')[2]
    expect(session.location_id).toBe('loc-first')
  })

  it('refuses a session id that belongs to someone else, writing nothing', async () => {
    const { db, calls } = makeDb({ existing: { profile_id: 'other', location_id: null } })
    const res = await recordUsageBatch(args(db))
    expect(res).toEqual({ recorded: false, reason: 'session_owner_mismatch' })
    expect(calls.some((c) => c[0] === 'upsert')).toBe(false)
  })

  it('answers recorded:false for a batch too old to keep', async () => {
    const { db, calls } = makeDb()
    const res = await recordUsageBatch({ ...args(db), batch: batch({ start: NOW - 72 * H, end: NOW - 71 * H }) })
    expect(res).toEqual({ recorded: false, reason: 'too_old' })
    expect(calls).toEqual([])
  })

  it('throws on a failed owner read, a failed session write or a failed visit write', async () => {
    await expect(recordUsageBatch(args(makeDb({ readError: { code: 'X' } }).db))).rejects.toThrow()
    await expect(recordUsageBatch(args(makeDb({ sessionError: { code: 'X' } }).db))).rejects.toThrow()
    await expect(recordUsageBatch(args(makeDb({ visitError: { code: 'X' } }).db))).rejects.toThrow()
  })

  it('skips the visit write when there are no visits', async () => {
    const { db, calls } = makeDb()
    await recordUsageBatch({ ...args(db), batch: { ...batch(), visits: [] } })
    expect(calls.filter((c) => c[0] === 'upsert').map((c) => c[1])).toEqual(['app_usage_sessions'])
  })
})
