import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { loadGroup, loadDeviceGroup, publicGroup } from './group-load.js'
import { GROUP_COLUMNS } from './effective'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const G_A = '90000000-0000-4000-8000-00000000000a'
const G_B = '90000000-0000-4000-8000-00000000000b'

function makeDb({ rows = [], error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, cols: null, filters: {} }
      calls.push(st)
      const b = {
        select: (cols) => { st.cols = cols; return b },
        eq: (col, val) => { st.filters[col] = val; return b },
        maybeSingle: async () => {
          if (error) return { data: null, error }
          const hit = rows.find((r) => Object.entries(st.filters).every(([k, v]) => r[k] === v))
          return { data: hit ?? null, error: null }
        },
      }
      return b
    },
  }
}

const rows = [
  { id: G_A, location_id: LOC_A, name: 'Gym floor', last_applied: { key: 'k' } },
  { id: G_B, location_id: LOC_B, name: 'Theirs' },
]

beforeEach(() => vi.clearAllMocks())

describe('loadGroup', () => {
  it('loads the caller’s own group with GROUP_COLUMNS, pinning the location', async () => {
    const db = makeDb({ rows })
    expect(await loadGroup(db, LOC_A, G_A)).toEqual({ ok: true, group: rows[0] })
    expect(db.calls[0]).toMatchObject({ table: 'shelly_groups', cols: GROUP_COLUMNS, filters: { id: G_A, location_id: LOC_A } })
  })
  it('404s a foreign id and a malformed one alike; a malformed id never queries', async () => {
    const db = makeDb({ rows })
    expect(await loadGroup(db, LOC_A, G_B)).toEqual({ ok: false, status: 404 })
    expect(await loadGroup(db, LOC_A, 'nope')).toEqual({ ok: false, status: 404 })
    expect(db.calls).toHaveLength(1)
  })
  it('a read failure is a 500, never a 404', async () => {
    expect(await loadGroup(makeDb({ error: { message: 'pg down' } }), LOC_A, G_A)).toEqual({ ok: false, status: 500, error: 'pg down' })
  })
})

describe('loadDeviceGroup', () => {
  it('an ungrouped device costs no read', async () => {
    const db = makeDb({ rows })
    expect(await loadDeviceGroup(db, { id: 'd', location_id: LOC_A, group_id: null })).toEqual({ ok: true, group: null })
    expect(db.calls).toEqual([])
  })
  it('loads the device’s group at the device’s location', async () => {
    const db = makeDb({ rows })
    expect(await loadDeviceGroup(db, { id: 'd', location_id: LOC_A, group_id: G_A })).toEqual({ ok: true, group: rows[0] })
  })
  it('a missing group or a failed read is unavailable — never "no group"', async () => {
    expect(await loadDeviceGroup(makeDb({ rows }), { id: 'd', location_id: LOC_A, group_id: G_B })).toEqual({ ok: false, reason: 'missing' })
    expect(await loadDeviceGroup(makeDb({ error: { message: 'x' } }), { id: 'd', location_id: LOC_A, group_id: G_A })).toEqual({ ok: false, reason: 'db_error', error: 'x' })
  })
})

describe('publicGroup', () => {
  it('drops last_applied (engine bookkeeping) and keeps the rest', () => {
    expect(publicGroup(rows[0])).toEqual({ id: G_A, location_id: LOC_A, name: 'Gym floor' })
  })
})
