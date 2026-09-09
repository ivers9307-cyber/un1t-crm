// ROSTER-FIX.1 (D1) — coaches never see draft shifts. The manager/non-manager
// split lives in the route, not the reader, so the calendar (managers) keeps
// its drafts while the mobile schedule feed (coaches) does not.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), getUserLocationIds: vi.fn(() => ['loc-1']) }))
vi.mock('@/lib/roster-read', () => ({ fetchApiShiftRows: vi.fn(() => Promise.resolve({ rows: [], error: null })) }))
const { getCurrentUser } = await import('@/lib/auth')
const { fetchApiShiftRows } = await import('@/lib/roster-read')
const { GET } = await import('./route.js')
const req = (url = 'http://x/api/schedule/shifts?location_id=loc-1') => ({ url })
beforeEach(() => { getCurrentUser.mockReset(); fetchApiShiftRows.mockClear() })

describe('GET /api/schedule/shifts — draft visibility (D1)', () => {
  it('a coach gets published shifts only', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', locations: [{ id: 'loc-1' }] })
    await GET(req())
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ publishedOnly: true }))
  })
  it('a manager sees drafts too', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', locations: [{ id: 'loc-1' }] })
    await GET(req())
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ publishedOnly: false }))
  })
})
