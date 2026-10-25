// src/lib/studio-doors.test.js
// WIDGET.1 — characterisation + unit tests for listAllowedDoors, extracted
// from GET /api/studio-management/doors (UNIFI-DOORS-SCOPE, mig 182). This
// is the security barrier that keeps the door inventory scoped to the
// caller's allowlist; a second consumer (the home-screen widget door
// picker) reuses this helper instead of re-deriving the intersection.
//
// UniFi client seam: getUnifiConfig + listDoors (src/lib/unifi-access.js)
// — stubbed here over the real module so `UnifiError` stays a real class
// (the helper branches on `e instanceof UnifiError`); importActual pulls
// the real class through so `instanceof` still works.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/unifi-access', async () => {
  const actual = await vi.importActual('@/lib/unifi-access')
  return { ...actual, getUnifiConfig: vi.fn(), listDoors: vi.fn() }
})

import { listAllowedDoors } from './studio-doors.js'
import { getUnifiConfig, listDoors, UnifiError } from '@/lib/unifi-access'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const LOCATION_ROW = { id: LOC, name: 'Stillorgan', settings: {} }
const CFG = { configured: true, host: 'unifi.test', apiToken: 't' }
const USER = { id: 'u1', role: 'manager' }

// Configurable fake DB. Only table touched by the helper: profile_locations
// (the UNIFI-DOORS-SCOPE allowlist read).
function mockDb({ assignment = { unifi_door_ids: null } } = {}) {
  return {
    from: (table) => {
      if (table === 'profile_locations') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () =>
          Promise.resolve({ data: assignment, error: null }) }) }) }),
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

function ctx(overrides = {}) {
  return { user: USER, location: LOCATION_ROW, locationId: LOC, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  getUnifiConfig.mockResolvedValue(CFG)
})

describe('listAllowedDoors — allowlist semantics', () => {
  it('null allowlist → every door, scope unrestricted', async () => {
    listDoors.mockResolvedValue([{ id: 'd1', name: 'Front' }, { id: 'd2', name: 'Back' }])
    const db = mockDb({ assignment: { unifi_door_ids: null } })
    const result = await listAllowedDoors(db, ctx())
    expect(result).toEqual({
      ok: true,
      scope: 'unrestricted',
      doors: [{ id: 'd1', name: 'Front' }, { id: 'd2', name: 'Back' }],
    })
  })

  it('undefined allowlist (no profile_locations row) → every door, scope unrestricted', async () => {
    listDoors.mockResolvedValue([{ id: 'd1', name: 'Front' }])
    const db = mockDb({ assignment: null })
    const result = await listAllowedDoors(db, ctx())
    expect(result.ok).toBe(true)
    expect(result.scope).toBe('unrestricted')
    expect(result.doors).toEqual([{ id: 'd1', name: 'Front' }])
  })

  it('empty array allowlist → zero doors, scope allowlist', async () => {
    listDoors.mockResolvedValue([{ id: 'd1', name: 'Front' }, { id: 'd2', name: 'Back' }])
    const db = mockDb({ assignment: { unifi_door_ids: [] } })
    const result = await listAllowedDoors(db, ctx())
    expect(result).toEqual({ ok: true, scope: 'allowlist', doors: [] })
  })

  it('populated allowlist → only the intersection', async () => {
    listDoors.mockResolvedValue([
      { id: 'd1', name: 'Front' },
      { id: 'd2', name: 'Back' },
      { id: 'd3', name: 'Side' },
    ])
    const db = mockDb({ assignment: { unifi_door_ids: ['d1', 'd3'] } })
    const result = await listAllowedDoors(db, ctx())
    expect(result.ok).toBe(true)
    expect(result.scope).toBe('allowlist')
    expect(result.doors).toEqual([{ id: 'd1', name: 'Front' }, { id: 'd3', name: 'Side' }])
  })
})

describe('listAllowedDoors — door shape normalisation', () => {
  it('normalises camelCase (unique_id, display_name)', async () => {
    listDoors.mockResolvedValue([{ unique_id: 'd1', display_name: 'Front Door' }])
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.doors).toEqual([{ id: 'd1', name: 'Front Door' }])
  })

  it('normalises snake_case (door_id, title)', async () => {
    listDoors.mockResolvedValue([{ door_id: 'd2', title: 'Back Door' }])
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.doors).toEqual([{ id: 'd2', name: 'Back Door' }])
  })

  it('drops a door with no id in any spelling', async () => {
    listDoors.mockResolvedValue([{ name: 'Ghost door' }, { id: 'd1', name: 'Front' }])
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.doors).toEqual([{ id: 'd1', name: 'Front' }])
  })

  it('a nameless door becomes "Unnamed door"', async () => {
    listDoors.mockResolvedValue([{ id: 'd1' }])
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.doors).toEqual([{ id: 'd1', name: 'Unnamed door' }])
  })
})

describe('listAllowedDoors — UniFi config and error handling', () => {
  it('UniFi not configured → not_configured result, NOT an empty door list', async () => {
    getUnifiConfig.mockResolvedValue({ configured: false })
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result).toEqual({ ok: false, reason: 'not_configured' })
    expect(listDoors).not.toHaveBeenCalled()
  })

  it('UnifiError with a status → that status is carried through', async () => {
    listDoors.mockRejectedValue(new UnifiError('Controller offline', { status: 504 }))
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unifi_error')
    expect(result.status).toBe(504)
    expect(result.message).toBe('Controller offline')
  })

  it('a non-UniFiError failure → 502 with a wrapped message', async () => {
    listDoors.mockRejectedValue(new Error('boom'))
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unifi_error')
    expect(result.status).toBe(502)
    expect(result.message).toBe('UniFi request failed: boom')
  })

  it('a UnifiError with no status → defaults to 502', async () => {
    listDoors.mockRejectedValue(new UnifiError('No status here'))
    const db = mockDb()
    const result = await listAllowedDoors(db, ctx())
    expect(result.status).toBe(502)
    expect(result.message).toBe('No status here')
  })
})
