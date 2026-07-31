// Coverage for GET /api/staff-devices — the fleet payload behind the
// device-health page, the staff-list Device column and the per-staff
// Devices card. Locks the auth gate (service-role reads mean NO RLS —
// the gate here is the only thing standing between a staffer and the
// whole fleet) and the verdict shaping.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermission } = await import('@/lib/permissions')
const { GET } = await import('./route.js')

// A tiny thenable builder mock: every chain method returns `this`, and
// awaiting resolves to { data, error } for the table named in from().
//
// It also RECORDS each call into `calls`, because the filters are
// load-bearing and a mock that ignores them lets them be deleted with the
// suite still green — dropping `.eq('active', true)` would leak
// deactivated ex-staff into the fleet (and into the nudge recipients).
function makeDb(tables, calls = []) {
  return {
    from(table) {
      const builder = {
        select: (cols) => { calls.push(['select', table, cols]); return builder },
        order: (col, opts) => { calls.push(['order', table, col, opts?.ascending]); return builder },
        eq: (col, val) => { calls.push(['eq', table, col, val]); return builder },
        range: (from, to) => { calls.push(['range', table, from, to]); return builder },
        limit: () => builder,
        in: () => builder,
        gte: () => builder,
        then: (resolve) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      }
      return builder
    },
  }
}

// Did `calls` record a call whose recorded fields start with these values?
const recorded = (calls, ...prefix) =>
  calls.some((c) => prefix.every((v, i) => c[i] === v))

const DAY = 86400_000
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString()

const settingsUser = { id: 'u-admin', profileRole: 'owner' }

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
})

describe('GET /api/staff-devices', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403s without the settings permission, before touching the DB', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', profileRole: 'staff' })
    hasPermission.mockReturnValue(false)
    const res = await GET()
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns the fleet with a derived target version', async () => {
    getCurrentUser.mockResolvedValue(settingsUser)
    const calls = []
    createServerClient.mockReturnValue(
      makeDb({
        profiles: [
          { id: 'p1', full_name: 'Richard Ivers', email: 'r@x.ie', role: 'owner', active: true },
          { id: 'p2', full_name: 'Lukasz K', email: 'l@x.ie', role: 'staff', active: true },
        ],
        device_tokens: [
          {
            id: 'd1', user_id: 'p1', platform: 'ios', device_name: 'iPhone',
            app_version: '2.2.0', last_seen_at: daysAgo(0), created_at: daysAgo(30),
            geofence_permission: 'always', geofence_permission_at: daysAgo(0),
          },
          {
            id: 'd2', user_id: 'p2', platform: 'ios', device_name: 'iPhone 12',
            app_version: '2.1.0', last_seen_at: daysAgo(1), created_at: daysAgo(40),
            geofence_permission: null, geofence_permission_at: null,
          },
        ],
      }, calls),
    )

    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.target_version).toBe('2.2.0')
    expect(json.data.staff).toHaveLength(2)

    // Pin the query shape — these filters are the payload's correctness.
    expect(recorded(calls, 'eq', 'profiles', 'active', true)).toBe(true)
    expect(recorded(calls, 'order', 'device_tokens', 'last_seen_at', false)).toBe(true)
    expect(recorded(calls, 'order', 'device_tokens', 'id', true)).toBe(true)
    expect(recorded(calls, 'range', 'profiles', 0, 999)).toBe(true)
    expect(recorded(calls, 'range', 'device_tokens', 0, 999)).toBe(true)
    const deviceSelect = calls.find((c) => c[0] === 'select' && c[1] === 'device_tokens')[2]
    expect(deviceSelect).toContain('geofence_permission')
    expect(deviceSelect).toContain('app_version')
    expect(deviceSelect).toContain('last_seen_at')

    const richard = json.data.staff.find(s => s.id === 'p1')
    expect(richard.verdict.kind).toBe('current')
    expect(richard.geofence_permission).toBe('always')
    expect(richard.devices).toHaveLength(1)

    const lukasz = json.data.staff.find(s => s.id === 'p2')
    expect(lukasz.verdict.kind).toBe('outdated')
    expect(lukasz.verdict.version).toBe('2.1.0')
    expect(lukasz.geofence_permission).toBeNull()
  })

  it('includes staff with no device rows as no_device', async () => {
    getCurrentUser.mockResolvedValue(settingsUser)
    createServerClient.mockReturnValue(
      makeDb({
        profiles: [
          { id: 'p1', full_name: 'Has App', email: 'a@x.ie', role: 'staff', active: true },
          { id: 'p9', full_name: 'Never Installed', email: 'n@x.ie', role: 'staff', active: true },
        ],
        device_tokens: [
          {
            id: 'd1', user_id: 'p1', platform: 'ios', device_name: 'iPhone',
            app_version: '2.2.0', last_seen_at: daysAgo(0), created_at: daysAgo(5),
            geofence_permission: null, geofence_permission_at: null,
          },
        ],
      }),
    )

    const json = await (await GET()).json()
    const never = json.data.staff.find(s => s.id === 'p9')
    expect(never.verdict.kind).toBe('no_device')
    expect(never.devices).toEqual([])
    expect(never.geofence_permission).toBeNull()
  })

  it('keys the verdict off the newest device and sorts devices newest-first', async () => {
    getCurrentUser.mockResolvedValue(settingsUser)
    createServerClient.mockReturnValue(
      makeDb({
        profiles: [
          { id: 'p1', full_name: 'Two Devices', email: 't@x.ie', role: 'staff', active: true },
        ],
        device_tokens: [
          // Old iPad on the newer build — must NOT mask the daily phone.
          {
            id: 'ipad', user_id: 'p1', platform: 'ios', device_name: 'iPad',
            app_version: '2.2.0', last_seen_at: daysAgo(40), created_at: daysAgo(90),
            geofence_permission: 'always', geofence_permission_at: daysAgo(40),
          },
          {
            id: 'phone', user_id: 'p1', platform: 'ios', device_name: 'iPhone',
            app_version: '2.1.0', last_seen_at: daysAgo(0), created_at: daysAgo(10),
            geofence_permission: 'when_in_use', geofence_permission_at: daysAgo(0),
          },
        ],
      }),
    )

    const json = await (await GET()).json()
    const staff = json.data.staff[0]
    // The stale iPad cannot set the target version either.
    expect(json.data.target_version).toBe('2.1.0')
    expect(staff.verdict.kind).toBe('current')
    expect(staff.verdict.deviceId).toBe('phone')
    expect(staff.geofence_permission).toBe('when_in_use')
    expect(staff.devices.map(d => d.id)).toEqual(['phone', 'ipad'])
    expect(staff.devices.find(d => d.id === 'ipad').stale).toBe(true)
    expect(staff.devices.find(d => d.id === 'phone').stale).toBe(false)
  })

  it('ignores a deactivated leaver\'s device when deriving the target version', async () => {
    getCurrentUser.mockResolvedValue(settingsUser)
    createServerClient.mockReturnValue(
      makeDb({
        // The profiles query filters active=true, so the leaver is absent
        // here — but their device row is still in device_tokens.
        profiles: [
          { id: 'p1', full_name: 'Still Here', email: 's@x.ie', role: 'staff', active: true },
        ],
        device_tokens: [
          {
            id: 'd-leaver', user_id: 'p-gone', platform: 'ios', device_name: 'Ex iPhone',
            app_version: '3.0.0', last_seen_at: daysAgo(1), created_at: daysAgo(20),
            geofence_permission: null, geofence_permission_at: null,
          },
          {
            id: 'd1', user_id: 'p1', platform: 'ios', device_name: 'iPhone',
            app_version: '2.2.0', last_seen_at: daysAgo(0), created_at: daysAgo(5),
            geofence_permission: null, geofence_permission_at: null,
          },
        ],
      }),
    )

    const json = await (await GET()).json()
    expect(json.data.target_version).toBe('2.2.0')
    expect(json.data.staff).toHaveLength(1)
    expect(json.data.staff[0].verdict.kind).toBe('current')
  })

  it('500s when a query errors', async () => {
    getCurrentUser.mockResolvedValue(settingsUser)
    createServerClient.mockReturnValue({
      from: () => ({
        select: function () { return this },
        eq: function () { return this },
        order: function () { return this },
        range: function () { return this },
        then: (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve),
      }),
    })
    const res = await GET()
    expect(res.status).toBe(500)
  })
})
