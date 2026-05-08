// Tests for bridge-samples.js — pure helpers (canonicaliseMac,
// buildHrSampleRows) plus DB-mocked tests for getActiveStrapMap
// and insertHrSamples.

import { describe, it, expect, vi } from 'vitest'
import {
  canonicaliseMac,
  buildHrSampleRows,
  getActiveStrapMap,
  insertHrSamples,
} from './bridge-samples.js'

// ── canonicaliseMac ──────────────────────────────────────────────

describe('canonicaliseMac', () => {
  it('canonicalises lowercase colon form', () => {
    expect(canonicaliseMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('canonicalises no-separator form', () => {
    expect(canonicaliseMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('canonicalises hyphen form', () => {
    expect(canonicaliseMac('AA-BB-CC-DD-EE-FF')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('returns null for non-12-hex inputs', () => {
    expect(canonicaliseMac('AA:BB:CC')).toBe(null)
    expect(canonicaliseMac('not a mac')).toBe(null)
    expect(canonicaliseMac('')).toBe(null)
    expect(canonicaliseMac(null)).toBe(null)
    expect(canonicaliseMac(undefined)).toBe(null)
  })
  it('returns null for non-string', () => {
    expect(canonicaliseMac(123)).toBe(null)
    expect(canonicaliseMac({})).toBe(null)
  })
})

// ── buildHrSampleRows ────────────────────────────────────────────

describe('buildHrSampleRows', () => {
  const strapMap = new Map([
    ['AA:BB:CC:DD:EE:FF', { sessionId: 'sess-1', contactId: 'c-1' }],
    ['11:22:33:44:55:66', { sessionId: 'sess-2', contactId: 'c-2' }],
  ])

  it('builds rows for paired straps', () => {
    const samples = [
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:00Z', bpm: 145 },
      { strap_mac: '11:22:33:44:55:66', recorded_at: '2026-05-08T16:00:00Z', bpm: 132 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toEqual([
      { session_id: 'sess-1', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 145 },
      { session_id: 'sess-2', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 132 },
    ])
    expect(stats).toEqual({ received: 2, accepted: 2, dropped_unpaired: 0, dropped_invalid: 0 })
  })

  it('drops unpaired straps', () => {
    const samples = [
      { strap_mac: 'DE:AD:BE:EF:00:01', recorded_at: '2026-05-08T16:00:00Z', bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(0)
    expect(stats.dropped_unpaired).toBe(1)
  })

  it('drops samples with invalid bpm (<30 or >240 or NaN)', () => {
    const samples = [
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:00Z', bpm: 25 },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:01Z', bpm: 250 },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:02Z', bpm: NaN },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:03Z', bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(1)
    expect(stats).toEqual({ received: 4, accepted: 1, dropped_unpaired: 0, dropped_invalid: 3 })
  })

  it('drops samples with invalid recorded_at', () => {
    const samples = [
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: 'not-a-date', bpm: 145 },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '', bpm: 145 },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: null, bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(0)
    expect(stats.dropped_invalid).toBe(3)
  })

  it('rounds non-integer bpm', () => {
    const samples = [
      { strap_mac: 'AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T16:00:00Z', bpm: 145.7 },
    ]
    const { rows } = buildHrSampleRows(samples, strapMap)
    expect(rows[0].bpm).toBe(146)
  })

  it('handles non-canonical strap_mac formats', () => {
    const samples = [
      { strap_mac: 'aa:bb:cc:dd:ee:ff', recorded_at: '2026-05-08T16:00:00Z', bpm: 145 },
      { strap_mac: 'AABBCCDDEEFF', recorded_at: '2026-05-08T16:00:01Z', bpm: 146 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(2)
    expect(stats.accepted).toBe(2)
  })

  it('returns empty rows for empty/null input', () => {
    expect(buildHrSampleRows([], strapMap).rows).toEqual([])
    expect(buildHrSampleRows(null, strapMap).rows).toEqual([])
    expect(buildHrSampleRows(undefined, strapMap).rows).toEqual([])
  })
})

// ── getActiveStrapMap ────────────────────────────────────────────

describe('getActiveStrapMap', () => {
  it('returns empty map when DB errors', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              not: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
            })),
          })),
        })),
      })),
    }
    const map = await getActiveStrapMap(db, 'bridge-1')
    expect(map.size).toBe(0)
  })

  it('builds map from DB rows, canonicalising MACs', async () => {
    const rows = [
      { strap_mac: 'aa:bb:cc:dd:ee:ff', contact_id: 'c-1', heart_rate_session_id: 'sess-1' },
      { strap_mac: '112233445566',     contact_id: 'c-2', heart_rate_session_id: 'sess-2' },
    ]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              not: vi.fn(() => Promise.resolve({ data: rows, error: null })),
            })),
          })),
        })),
      })),
    }
    const map = await getActiveStrapMap(db, 'bridge-1')
    expect(map.get('AA:BB:CC:DD:EE:FF')).toEqual({ sessionId: 'sess-1', contactId: 'c-1' })
    expect(map.get('11:22:33:44:55:66')).toEqual({ sessionId: 'sess-2', contactId: 'c-2' })
  })

  it('skips rows without strap_mac or session_id', async () => {
    const rows = [
      { strap_mac: null, contact_id: 'c-1', heart_rate_session_id: 'sess-1' },
      { strap_mac: 'AA:BB:CC:DD:EE:FF', contact_id: 'c-2', heart_rate_session_id: null },
    ]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              not: vi.fn(() => Promise.resolve({ data: rows, error: null })),
            })),
          })),
        })),
      })),
    }
    const map = await getActiveStrapMap(db, 'bridge-1')
    expect(map.size).toBe(0)
  })
})

// ── insertHrSamples ─────────────────────────────────────────────

describe('insertHrSamples', () => {
  it('skips when rows is empty', async () => {
    const db = { from: vi.fn() }
    const out = await insertHrSamples(db, [])
    expect(out).toEqual({ inserted: 0, error: null })
    expect(db.from).not.toHaveBeenCalled()
  })

  // Two-table dispatch helper: hr_samples uses upsert(); the touch
  // path on heart_rate_sessions uses update().eq() which returns
  // a thenable.
  function makeDb({ upsertResult = { error: null, count: 0 }, sessionUpdateError = null } = {}) {
    const upsert = vi.fn(() => Promise.resolve(upsertResult))
    const sessionEq = vi.fn(() => Promise.resolve({ error: sessionUpdateError }))
    const sessionUpdate = vi.fn(() => ({ eq: sessionEq }))
    return {
      from: vi.fn((table) => {
        if (table === 'hr_samples') return { upsert }
        if (table === 'heart_rate_sessions') return { update: sessionUpdate }
        throw new Error(`unexpected table ${table}`)
      }),
      _spies: { upsert, sessionUpdate, sessionEq },
    }
  }

  it('upserts with onConflict ignoreDuplicates', async () => {
    const db = makeDb({ upsertResult: { error: null, count: 3 } })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-08T16:00:01.000Z', bpm: 146 },
      { session_id: 's', recorded_at: '2026-05-08T16:00:02.000Z', bpm: 147 },
    ]
    const out = await insertHrSamples(db, rows)
    expect(out).toEqual({ inserted: 3, error: null })
    expect(db.from).toHaveBeenCalledWith('hr_samples')
    expect(db._spies.upsert).toHaveBeenCalledWith(rows, expect.objectContaining({
      onConflict: 'session_id,recorded_at',
      ignoreDuplicates: true,
    }))
  })

  it('touches last_sample_at to the LATEST recorded_at per session', async () => {
    const db = makeDb({ upsertResult: { error: null, count: 4 } })
    const rows = [
      { session_id: 'sA', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 145 },
      { session_id: 'sA', recorded_at: '2026-05-08T16:00:02.000Z', bpm: 147 }, // newer
      { session_id: 'sA', recorded_at: '2026-05-08T16:00:01.000Z', bpm: 146 },
      { session_id: 'sB', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 130 },
    ]
    await insertHrSamples(db, rows)
    expect(db._spies.sessionUpdate).toHaveBeenCalledTimes(2)
    expect(db._spies.sessionUpdate).toHaveBeenCalledWith({ last_sample_at: '2026-05-08T16:00:02.000Z' })
    expect(db._spies.sessionUpdate).toHaveBeenCalledWith({ last_sample_at: '2026-05-08T16:00:00.000Z' })
  })

  it('still returns inserted on a touch failure (best-effort)', async () => {
    const db = makeDb({
      upsertResult: { error: null, count: 1 },
      sessionUpdateError: { message: 'rls' },
    })
    const out = await insertHrSamples(db, [{ session_id: 's', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 145 }])
    expect(out.error).toBe(null)
    expect(out.inserted).toBe(1)
  })

  it('returns error from supabase rather than throwing', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'rls' }, count: 0 } })
    const out = await insertHrSamples(db, [{ session_id: 's', recorded_at: '2026-05-08T16:00:00.000Z', bpm: 145 }])
    expect(out.error).toBeTruthy()
    expect(out.inserted).toBe(0)
  })
})
