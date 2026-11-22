// USUALCOACH.1 — POST /api/schedule/shifts/fill-usual: manager at the studio,
// this week or later, the studio's shifts only. The fill rules themselves are
// tested in src/lib/shift-usual-coaches.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    userAtLocation: real.userAtLocation,
    assertLocationAccess: real.assertLocationAccess,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/location-time', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocationZone: vi.fn(async () => 'Europe/Dublin'),
  todayStrIn: vi.fn(() => '2026-12-09'),
}))
vi.mock('@/lib/shift-usual-coaches', () => ({ readBlocksForFill: vi.fn(), fillUsualCoaches: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readBlocksForFill, fillUsualCoaches } = await import('@/lib/shift-usual-coaches')
const { getLocationZone } = await import('@/lib/location-time')
const { logInfo } = await import('@/lib/log')
const { POST } = await import('./route.js')

const LOC_A = 'a0000000-0000-4000-8000-000000000001'
const LOC_B = 'b0000000-0000-4000-8000-000000000002'
const MGR_A_STAFF_B = {
  id: 'mgr', role: 'manager', profileRole: 'staff', activeLocation: { id: LOC_A },
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
}
const req = (body) => new Request('http://localhost/api/schedule/shifts/fill-usual', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MGR_A_STAFF_B)
  readBlocksForFill.mockResolvedValue({ blocks: [{ id: 'b1', location_id: LOC_A }, { id: 'bx', location_id: LOC_B }], error: null })
  fillUsualCoaches.mockResolvedValue({
    assigned: [{ block_id: 'b1', profile_id: 'p1' }],
    skipped: [{ block_id: 'b1', profile_id: 'p2', reason: 'time_off' }, { block_id: 'b9', profile_id: null, reason: 'already_staffed' }],
    counts: { time_off: 1, already_staffed: 1 },
  })
})

describe('POST /api/schedule/shifts/fill-usual', () => {
  it('fills the studio\'s shifts from today to Sunday, as the manager, and reports the skips', async () => {
    const res = await POST(req({ location_id: LOC_A, week_start: '2026-12-07' }))
    expect(res.status).toBe(200)
    expect(readBlocksForFill).toHaveBeenCalledWith(expect.anything(), { locationId: LOC_A, startDate: '2026-12-09', endDate: '2026-12-13' })
    // Only this studio's rows reach the fill.
    expect(fillUsualCoaches).toHaveBeenCalledWith(expect.anything(), [{ id: 'b1', location_id: LOC_A }], { actorId: 'mgr' })
    expect(await res.json()).toEqual({
      success: true, assigned: 1, skipped: 2, counts: { time_off: 1, already_staffed: 1 },
      skipped_coaches: [{ block_id: 'b1', profile_id: 'p2', reason: 'time_off' }],
    })
    // Counts in the log, never names.
    expect(JSON.stringify(logInfo.mock.calls)).not.toMatch(/p2|full_name/)
  })

  it('a later week is filled from its Monday', async () => {
    await POST(req({ location_id: LOC_A, week_start: '2026-12-14' }))
    expect(readBlocksForFill).toHaveBeenCalledWith(expect.anything(), { locationId: LOC_A, startDate: '2026-12-14', endDate: '2026-12-20' })
  })

  it('refuses a week that is over', async () => {
    expect((await POST(req({ location_id: LOC_A, week_start: '2026-11-30' }))).status).toBe(400)
    expect(fillUsualCoaches).not.toHaveBeenCalled()
  })

  it('refuses a studio where the caller is staff, and one they do not belong to', async () => {
    expect((await POST(req({ location_id: LOC_B, week_start: '2026-12-07' }))).status).toBe(403)
    getCurrentUser.mockResolvedValue({ ...MGR_A_STAFF_B, locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } })
    expect((await POST(req({ location_id: LOC_B, week_start: '2026-12-07' }))).status).toBe(403)
    expect(readBlocksForFill).not.toHaveBeenCalled()
  })

  it('signed out is 401; a bad body is 400', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await POST(req({ location_id: LOC_A, week_start: '2026-12-07' }))).status).toBe(401)
    expect((await POST(req({ location_id: LOC_A, week_start: '2026-02-30' }))).status).toBe(400)
    expect(readBlocksForFill).not.toHaveBeenCalled()
  })

  it('an unreadable studio clock or shift read changes nothing', async () => {
    getLocationZone.mockRejectedValueOnce(new Error('down'))
    expect((await POST(req({ location_id: LOC_A, week_start: '2026-12-07' }))).status).toBe(503)
    readBlocksForFill.mockResolvedValueOnce({ blocks: [], error: { message: 'down' } })
    expect((await POST(req({ location_id: LOC_A, week_start: '2026-12-07' }))).status).toBe(500)
    expect(fillUsualCoaches).not.toHaveBeenCalled()
  })
})
