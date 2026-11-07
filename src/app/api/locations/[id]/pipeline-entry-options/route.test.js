import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))
vi.mock('@/lib/pipeline-entry-options', async () => {
  const actual = await vi.importActual('@/lib/pipeline-entry-options')
  return { ...actual, listEntryOptions: vi.fn(actual.listEntryOptions) }
})

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { listEntryOptions } from '@/lib/pipeline-entry-options'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: LOC }) }
const req = (qs) => new Request(`http://x/api/locations/${LOC}/pipeline-entry-options?${qs}`)
const userWith = (role, locs = [LOC]) => ({
  id: 'u', role, profileRole: role, isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
})

describe('GET /api/locations/[id]/pipeline-entry-options', () => {
  it('unknownTypeIs400', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    const res = await GET(req('type=nope'), props)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('unknown_type')
    expect((await GET(req(''), props)).status).toBe(400)
  })

  it('leadSourceForAManager', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    const res = await GET(req('type=lead_source'), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.options.map((o) => o.value)).toContain('meta')
    expect(listEntryOptions).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, type: 'lead_source', match: undefined })
  })

  it('passesMatchThrough', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    listEntryOptions.mockResolvedValueOnce({ ok: true, options: [{ value: 'P39', label: 'P39' }] })
    const res = await GET(req('type=trial_purchase&match=plan_code'), props)
    expect(res.status).toBe(200)
    expect(listEntryOptions).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, type: 'trial_purchase', match: 'plan_code' })
  })

  it('sequenceBuilderStaffCanRead', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    canBuildSequencesAt.mockReturnValue(true)
    expect((await GET(req('type=corp_promo'), props)).status).toBe(200)
  })

  it('staffWithoutPermissionIs403', async () => {
    getCurrentUser.mockResolvedValue(userWith('staff'))
    expect((await GET(req('type=corp_promo'), props)).status).toBe(403)
    expect(listEntryOptions).not.toHaveBeenCalled()
  })

  it('otherStudioIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    expect((await GET(req('type=corp_promo'), props)).status).toBe(404)
    expect(listEntryOptions).not.toHaveBeenCalled()
  })

  it('readFailureIs503', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    listEntryOptions.mockResolvedValueOnce({ ok: false, status: 503, error: 'Could not read' })
    expect((await GET(req('type=glofox_plan'), props)).status).toBe(503)
  })
})
