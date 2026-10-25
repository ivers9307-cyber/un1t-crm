// TZ.9 — GET /api/races/today asks for the STUDIO's day (its
// locations.timezone), never Dublin's for everyone; an unreadable zone is a
// failed read (500), never a guessed day.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'manager', activeLocation: { id: 'L1' } })),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: () => true, hasPermissionForLocation: () => true }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { GET } = await import('./route.js')

function db({ zone = { data: { id: 'L1', timezone: 'Europe/Dublin' }, error: null } } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const b = {}
      for (const m of ['select', 'eq']) b[m] = (...a) => { calls.push([table, m, ...a]); return b }
      b.maybeSingle = async () => (table === 'locations' ? zone : { data: null, error: null })
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
      return b
    },
  }
}
const raceDateAsked = (d) => d.calls.find((c) => c[0] === 'race_events' && c[1] === 'eq' && c[2] === 'race_date')?.[3]
const get = () => GET(new Request('http://localhost/api/races/today?location_id=L1'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Dublin is Sunday 1 Nov 03:30; New York is Saturday 31 Oct 23:30.
  vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  resetLocationZoneCache()
})

describe('GET /api/races/today — the studio day (TZ.9)', () => {
  it('a Dublin studio asks for Dublin\'s day, as before', async () => {
    const d = db()
    createServerClient.mockReturnValue(d)
    expect((await get()).status).toBe(200)
    expect(raceDateAsked(d)).toBe('2026-11-01')
  })
  it('a New York studio asks for New York\'s day', async () => {
    const d = db({ zone: { data: { id: 'L1', timezone: 'America/New_York' }, error: null } })
    createServerClient.mockReturnValue(d)
    expect((await get()).status).toBe(200)
    expect(raceDateAsked(d)).toBe('2026-10-31')
  })
  it('an unreadable zone is a 500 and no race read', async () => {
    const d = db({ zone: { data: null, error: { message: 'down' } } })
    createServerClient.mockReturnValue(d)
    expect((await get()).status).toBe(500)
    expect(raceDateAsked(d)).toBeUndefined()
  })
})
