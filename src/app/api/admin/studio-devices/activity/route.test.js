// Coverage for GET /api/admin/studio-devices/activity — the master-only
// PIN-attempt activity feed. Locks the auth gate and the shaping that
// resolves device labels + matched-staffer names from bulk lookups.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

// A tiny thenable builder mock: every chain method returns `this`, and
// awaiting resolves to { data, error } for the table named in from().
function makeDb(tables) {
  return {
    from(table) {
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        then: (resolve) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      }
      return builder
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/studio-devices/activity', () => {
  it('403s a non-master', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'manager' })
    const from = vi.fn()
    createServerClient.mockReturnValue({ from })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(from).not.toHaveBeenCalled()
  })

  it('a non-master gets the same 403 "Forbidden" body as before', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', profileRole: 'owner', isMaster: false })
    const res = await GET()
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  // ROUTEWRAP.R11 — signed out is withAuth's 401 (it was a 403 before).
  it('401s when there is no user, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns recent attempts with device + matched name resolved', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', profileRole: 'master', isMaster: true })
    createServerClient.mockReturnValue(
      makeDb({
        pin_login_attempts: [
          {
            id: 1,
            attempted_at: '2026-06-27T14:08:00Z',
            outcome: 'untrusted_ip',
            source_ip: '89.100.70.214',
            device_id: 'dev-1',
            matched_profile: null,
          },
          {
            id: 2,
            attempted_at: '2026-06-27T14:37:00Z',
            outcome: 'success',
            source_ip: '89.100.70.214',
            device_id: 'dev-1',
            matched_profile: 'p-1',
          },
          {
            id: 3,
            attempted_at: '2026-06-27T13:00:00Z',
            outcome: 'unknown_device',
            source_ip: '10.0.0.9',
            device_id: null,
            matched_profile: null,
          },
        ],
        studio_devices: [
          { id: 'dev-1', label: 'Reception iPad', device_kind: 'ipad', location_id: 'loc-1' },
        ],
        profiles: [{ id: 'p-1', full_name: 'Richard Ivers' }],
      }),
    )

    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.attempts).toHaveLength(3)

    const [untrusted, success, unknown] = json.attempts
    expect(untrusted.outcome).toBe('untrusted_ip')
    expect(untrusted.device.label).toBe('Reception iPad')
    expect(untrusted.matched_name).toBeNull()

    expect(success.matched_name).toBe('Richard Ivers')
    expect(success.device.location_id).toBe('loc-1')

    // device_id null (unknown-device attempt) → device is null, no throw.
    expect(unknown.device).toBeNull()
    expect(unknown.source_ip).toBe('10.0.0.9')
  })

  it('500s when the attempts query errors', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', profileRole: 'master', isMaster: true })
    createServerClient.mockReturnValue({
      from: () => ({
        select: function () { return this },
        order: function () { return this },
        limit: function () { return this },
        then: (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve),
      }),
    })
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('boom')
  })
})
