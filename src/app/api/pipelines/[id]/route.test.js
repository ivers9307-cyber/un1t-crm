import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ boardLocationId: vi.fn(), getBoard: vi.fn(), updateBoard: vi.fn() }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn() }))

import { GET, PATCH } from './route'
import { getCurrentUser } from '@/lib/auth'
import { boardLocationId, getBoard, updateBoard } from '@/lib/pipeline-boards'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BOARD = 'b0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: BOARD }) }
const userWith = (role, locs = [LOC]) => ({
  id: 'u1', role, profileRole: 'staff', isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})
const getReq = () => new Request(`http://x/api/pipelines/${BOARD}`)
const patchReq = (b) => new Request(`http://x/api/pipelines/${BOARD}`, { method: 'PATCH', body: JSON.stringify(b) })

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
  canManageWaTemplatesAt.mockReturnValue(false)
  boardLocationId.mockResolvedValue({ ok: true, locationId: LOC })
  getBoard.mockResolvedValue({ ok: true, board: { id: BOARD } })
  updateBoard.mockResolvedValue({ ok: true, board: { id: BOARD, name: 'New' } })
})

describe('GET /api/pipelines/[id]', () => {
  it('otherStudioBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    const res = await GET(getReq(), props)
    expect(res.status).toBe(404)
    expect(getBoard).not.toHaveBeenCalled()
  })

  it('missingBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    boardLocationId.mockResolvedValue({ ok: false, status: 404, error: 'Not found' })
    expect((await GET(getReq(), props)).status).toBe(404)
  })

  it('badIdIs404WithoutARead', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await GET(getReq(), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(404)
    expect(boardLocationId).not.toHaveBeenCalled()
  })

  it('managerCanReadAndWordingNeedsBothPermissions', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    let json = await (await GET(getReq(), props)).json()
    expect(json).toEqual({ success: true, data: { board: { id: BOARD }, can_edit: false, can_edit_wording: false } })
    expect(getBoard).toHaveBeenCalledWith(expect.anything(), LOC, BOARD)

    canBuildSequencesAt.mockReturnValue(true)
    canManageWaTemplatesAt.mockReturnValue(true)
    json = await (await GET(getReq(), props)).json()
    expect(json.data).toMatchObject({ can_edit: false, can_edit_wording: true })
  })

  it('ownerCanEditEverything', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const json = await (await GET(getReq(), props)).json()
    expect(json.data).toMatchObject({ can_edit: true, can_edit_wording: true })
  })

  it('staffWithoutPermissionIs403', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    expect((await GET(getReq(), props)).status).toBe(403)
  })
})

describe('PATCH /api/pipelines/[id]', () => {
  it('otherStudioBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await PATCH(patchReq({ name: 'New' }), props)).status).toBe(404)
    expect(updateBoard).not.toHaveBeenCalled()
  })

  it('managerCannotEdit', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    expect((await PATCH(patchReq({ name: 'New' }), props)).status).toBe(403)
    expect(updateBoard).not.toHaveBeenCalled()
  })

  it('ownerEditsThroughTheLibrary', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await PATCH(patchReq({ name: 'New', priority: 10 }), props)
    expect(res.status).toBe(200)
    expect(updateBoard).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, boardId: BOARD, patch: { name: 'New', priority: 10 } })
  })

  it('emptyPatchIs400', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    expect((await PATCH(patchReq({}), props)).status).toBe(400)
  })

  it('switchOffFirstPassesThrough', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    updateBoard.mockResolvedValue({ ok: false, status: 409, code: 'switch_off_first', error: 'Switch the board off before changing its entry rule, stages or timings.' })
    const res = await PATCH(patchReq({ priority: 3 }), props)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('switch_off_first')
  })
})
