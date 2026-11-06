import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-stage-coverage', () => ({ loadStageCoverage: vi.fn() }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { loadStageCoverage } from '@/lib/pipeline-stage-coverage'
import { canBuildSequencesAt } from '@/lib/sequence-access'

const props = { params: { id: 'loc1' } }
const req = () => new Request('http://x/api/locations/loc1/stage-coverage')
const userWith = (role, locs = ['loc1']) => ({
  id: 'u', role, profileRole: role, isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
})

describe('GET /api/locations/[id]/stage-coverage', () => {
  it('404ForOtherStudio', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
    expect(loadStageCoverage).not.toHaveBeenCalled()
  })

  it('403WithoutPermission', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    const res = await GET(req(), props)
    expect(res.status).toBe(403)
    expect(loadStageCoverage).not.toHaveBeenCalled()
  })

  it('200ForManager', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    loadStageCoverage.mockResolvedValue({ ok: true, boards: [{ id: 'b1', key: 'main', name: 'Main', stages: [] }] })
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { boards: [{ id: 'b1', key: 'main', name: 'Main', stages: [] }] } })
  })

  it('503OnReadError', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    loadStageCoverage.mockResolvedValue({ ok: false, error: 'boom' })
    const res = await GET(req(), props)
    expect(res.status).toBe(503)
  })
})
