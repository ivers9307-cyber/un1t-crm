import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ boardLocationId: vi.fn(), getBoard: vi.fn() }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn() }))
vi.mock('@/lib/pipeline-board-report', () => ({ buildBoardReport: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { boardLocationId, getBoard } from '@/lib/pipeline-boards'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { hasPermissionForLocation } from '@/lib/permissions'
import { buildBoardReport } from '@/lib/pipeline-board-report'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BOARD = 'b0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: BOARD }) }
const userWith = (role, locs = [LOC]) => ({
  id: 'u1', role, profileRole: 'staff', isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})
const req = () => new Request(`http://x/api/pipelines/${BOARD}/report`)

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
  hasPermissionForLocation.mockReturnValue(true)
  boardLocationId.mockResolvedValue({ ok: true, locationId: LOC })
  getBoard.mockResolvedValue({ ok: true, board: { id: BOARD, board_type: 'offer' } })
  buildBoardReport.mockResolvedValue({ funnel: {}, conversion: {}, revenue: { offerCents: 1 }, followups: [], health: [] })
})

describe('GET /api/pipelines/[id]/report', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req(), props)).status).toBe(401)
  })
  it("404 for another studio's board", async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await GET(req(), props)).status).toBe(404)
    expect(buildBoardReport).not.toHaveBeenCalled()
  })
  it('403 for plain staff without the builder permission', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    expect((await GET(req(), props)).status).toBe(403)
  })
  it('404 for a built-in board', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    getBoard.mockResolvedValue({ ok: true, board: { id: BOARD, board_type: null } })
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Report is for offer boards')
  })
  it('asks for revenue only with dashboard_business', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    hasPermissionForLocation.mockReturnValue(false)
    await GET(req(), props)
    expect(buildBoardReport.mock.calls[0][1].includeRevenue).toBe(false)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(expect.anything(), LOC, 'dashboard_business')
  })
  it('200 with the report', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Object.keys(body.data)).toEqual(['funnel', 'conversion', 'revenue', 'followups', 'health'])
    expect(buildBoardReport.mock.calls[0][1].includeRevenue).toBe(true)
  })
})
