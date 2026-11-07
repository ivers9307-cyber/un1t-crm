import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ listBoards: vi.fn(), createBoard: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ locationsWithWhatsApp: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))

import { GET, POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { listBoards, createBoard } from '@/lib/pipeline-boards'
import { locationsWithWhatsApp } from '@/lib/whatsapp-config'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const props = { params: Promise.resolve({ id: LOC }) }
const userWith = (role, locs = [LOC]) => ({
  id: 'u1', role, profileRole: role === 'master' ? 'master' : 'staff', isMaster: role === 'master',
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: role === 'master' ? {} : Object.fromEntries(locs.map((id) => [id, role])),
})
const body = { name: 'Reset 39', recipe_key: 'paid_trial_offer', config: { entry: {} }, priority: 50 }
const postReq = (b = body) => new Request(`http://x/api/locations/${LOC}/pipelines`, { method: 'POST', body: JSON.stringify(b) })
const getReq = () => new Request(`http://x/api/locations/${LOC}/pipelines`)

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
  locationsWithWhatsApp.mockResolvedValue(new Set([LOC]))
  listBoards.mockResolvedValue({ ok: true, boards: [{ id: 'b1' }] })
  createBoard.mockResolvedValue({ ok: true, board: { id: 'b2', enabled: false } })
})

describe('GET /api/locations/[id]/pipelines', () => {
  it('hasWhatsappTrueFalseNull', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    expect((await (await GET(getReq(), props)).json()).data.has_whatsapp).toBe(true)
    locationsWithWhatsApp.mockResolvedValue(new Set())
    expect((await (await GET(getReq(), props)).json()).data.has_whatsapp).toBe(false)
    locationsWithWhatsApp.mockRejectedValue(new Error('boom'))
    const res = await GET(getReq(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.has_whatsapp).toBeNull()
    expect(logError).toHaveBeenCalledWith('pipelines', 'has_whatsapp read failed', { locationId: LOC, err: 'boom' })
  })

  it('otherStudioIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    const res = await GET(getReq(), props)
    expect(res.status).toBe(404)
    expect(listBoards).not.toHaveBeenCalled()
  })

  it('badLocationIdIs404WithoutARead', async () => {
    getCurrentUser.mockResolvedValue(userWith('master'))
    const bad = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    expect((await GET(getReq(), bad)).status).toBe(404)
    expect((await POST(postReq(), bad)).status).toBe(404)
    expect(listBoards).not.toHaveBeenCalled()
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('managerCanList', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    const res = await GET(getReq(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { boards: [{ id: 'b1' }], can_edit: false, has_whatsapp: true } })
    expect(listBoards).toHaveBeenCalledWith(expect.anything(), LOC)
  })

  it('sequenceBuilderCanListStaffCannot', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    expect((await GET(getReq(), props)).status).toBe(403)
    canBuildSequencesAt.mockReturnValue(true)
    expect((await GET(getReq(), props)).status).toBe(200)
  })

  it('ownerSeesCanEdit', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const json = await (await GET(getReq(), props)).json()
    expect(json.data.can_edit).toBe(true)
  })

  it('readFailureIs503', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    listBoards.mockResolvedValue({ ok: false, status: 503, error: 'Could not read the boards.' })
    expect((await GET(getReq(), props)).status).toBe(503)
  })
})

describe('POST /api/locations/[id]/pipelines', () => {
  it('managerCannotCreate', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    const res = await POST(postReq(), props)
    expect(res.status).toBe(403)
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('orgAdminCanCreate', async () => {
    // An org admin carries a synthetic owner role at every studio of their org.
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await POST(postReq(), props)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, data: { board: { id: 'b2', enabled: false } } })
    expect(createBoard).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: { entry: {} }, priority: 50, createdBy: 'u1',
    })
  })

  it('masterCanCreate', async () => {
    getCurrentUser.mockResolvedValue(userWith('master'))
    expect((await POST(postReq(), props)).status).toBe(201)
  })

  it('otherStudioIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await POST(postReq(), props)).status).toBe(404)
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('badBodyIs400AndPriorityIsBounded', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    expect((await POST(postReq({ ...body, priority: 0 }), props)).status).toBe(400)
    expect((await POST(postReq({ ...body, priority: 1001 }), props)).status).toBe(400)
    expect((await POST(postReq({ ...body, name: '  ' }), props)).status).toBe(400)
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('passesTheLibraryRefusalThrough', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    createBoard.mockResolvedValue({ ok: false, status: 409, error: "Offer boards at un1t.online studios aren't available yet.", code: 'un1t_studio' })
    const res = await POST(postReq(), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: "Offer boards at un1t.online studios aren't available yet.", code: 'un1t_studio' })
  })
})
