import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ boardLocationId: vi.fn(), setBoardEnabled: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { boardLocationId, setBoardEnabled } from '@/lib/pipeline-boards'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BOARD = 'b0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: BOARD }) }
const userWith = (role, locs = [LOC]) => ({
  id: 'u1', role, profileRole: 'staff', isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})
const req = () => new Request(`http://x/api/pipelines/${BOARD}/disable`, { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  boardLocationId.mockResolvedValue({ ok: true, locationId: LOC })
  setBoardEnabled.mockResolvedValue({ ok: true, board: { id: BOARD, enabled: false } })
})

describe('POST /api/pipelines/[id]/disable', () => {
  it('otherStudioBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await POST(req(), props)).status).toBe(404)
    expect(setBoardEnabled).not.toHaveBeenCalled()
  })

  it('managerCannotSwitch', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    expect((await POST(req(), props)).status).toBe(403)
    expect(setBoardEnabled).not.toHaveBeenCalled()
  })

  it('ownerSwitchesThroughTheLibrary', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { board: { id: BOARD, enabled: false } } })
    expect(setBoardEnabled).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, boardId: BOARD, enabled: false })
  })

  it('alreadyThereSaysUnchanged', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    setBoardEnabled.mockResolvedValue({ ok: true, board: { id: BOARD, enabled: false }, unchanged: true })
    expect((await (await POST(req(), props)).json()).data.unchanged).toBe(true)
  })

  it('legacyBoardIs409', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    setBoardEnabled.mockResolvedValue({ ok: false, status: 409, code: 'legacy_board', error: "This board is built in code and can't be changed here." })
    expect((await POST(req(), props)).status).toBe(409)
  })
})
