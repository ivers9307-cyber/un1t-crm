import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ boardLocationId: vi.fn(), getBoard: vi.fn(), listBoards: vi.fn() }))
vi.mock('@/lib/pipeline-reclassify', () => ({ reclassifyAllContacts: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { boardLocationId, getBoard, listBoards } from '@/lib/pipeline-boards'
import { reclassifyAllContacts } from '@/lib/pipeline-reclassify'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BOARD = 'b0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: BOARD }) }
const owner = {
  id: 'u1', role: 'owner', profileRole: 'staff', isMaster: false,
  activeLocation: { id: LOC }, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'owner' },
}
const req = () => new Request(`http://x/api/pipelines/${BOARD}/dry-run`, { method: 'POST' })
const board = (over = {}) => ({
  id: BOARD, key: 'o_sale', name: 'Sale', board_type: 'offer', enabled: false,
  stages: [{ slug: 'a', name: 'First', display_order: 1 }], ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
  boardLocationId.mockResolvedValue({ ok: true, locationId: LOC })
  getBoard.mockResolvedValue({ ok: true, board: board() })
  listBoards.mockResolvedValue({ ok: true, boards: [board()] })
  reclassifyAllContacts.mockResolvedValue({
    ok: true, board_histogram: { o_sale: 2 }, stage_histogram: { a: 2 }, board_overlap: {}, contacts_seen: 10, errors: [],
  })
})

describe('POST /api/pipelines/[id]/dry-run', () => {
  it('routeIncludesDisabledBoard', async () => {
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.entering).toBe(2)
    expect(reclassifyAllContacts).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC, dryRun: true, source: 'manual', userId: 'u1', includeDisabledBoardIds: [BOARD],
    })
    getBoard.mockResolvedValue({ ok: true, board: board({ enabled: true }) })
    await POST(req(), props)
    expect(reclassifyAllContacts.mock.calls[1][1].includeDisabledBoardIds).toEqual([])
  })

  it('routeRefusesLegacyBoard', async () => {
    getBoard.mockResolvedValue({ ok: true, board: board({ board_type: null }) })
    expect((await POST(req(), props)).status).toBe(409)
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
  })

  it('failedRunIs503', async () => {
    reclassifyAllContacts.mockResolvedValue({ ok: false, error: 'boom' })
    const res = await POST(req(), props)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('boom')
  })

  it('otherStudioIs404AndManagerIs403', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, locations: [{ id: 'x' }], rolesByLocation: { x: 'owner' }, activeLocation: { id: 'x' } })
    expect((await POST(req(), props)).status).toBe(404)
    getCurrentUser.mockResolvedValue({ ...owner, role: 'manager', rolesByLocation: { [LOC]: 'manager' } })
    expect((await POST(req(), props)).status).toBe(403)
  })
})
