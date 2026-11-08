// WAYSIN.5 — /api/locations/[id]/lead-sources: anyone with Contacts at the
// studio reads the vocabulary; only an owner or master AT the studio writes the
// owner's list, through mergeLocationSettings.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_LEAD_SOURCES } from '@/lib/schemas'

beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionForLocation.mockReturnValue(true)
})

const props = { params: { id: 'loc1' } }
const putReq = (body) => new Request('http://x/api/locations/loc1/lead-sources', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const getReq = () => new Request('http://x/api/locations/loc1/lead-sources')

const owner = {
  id: 'u', role: 'owner', profileRole: 'owner', isMaster: false,
  activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'owner' },
}
const withRole = (role) => ({ ...owner, role, profileRole: role, rolesByLocation: { loc1: role } })

function mockDb(settings = {}, { contacts = [], contactsError = null } = {}) {
  let written = null
  const locationRow = () => Promise.resolve({ data: { id: 'loc1', settings }, error: null })
  createServerClient.mockReturnValue({
    from: (table) => ({
      select: () => {
        const q = {
          eq: () => q,
          order: () => q,
          range: () => Promise.resolve(contactsError ? { data: null, error: contactsError } : { data: contacts, error: null }),
          maybeSingle: locationRow,
          single: locationRow,
        }
        return q
      },
      update: (patch) => {
        written = { table, patch }
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) }
      },
    }),
  })
  return () => written
}

describe('GET', () => {
  it('lists each value with its origin; can_edit false for a manager', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    mockDb({ lead_sources: ['clubhouse_partner', 'meta'] }, { contacts: [{ id: 'c1', lead_source: 'corp_promo', last_lead_source: null }] })
    const res = await GET(getReq(), props)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.can_edit).toBe(false)
    expect(data.studio_sources).toEqual(['clubhouse_partner', 'meta'])
    expect(data.sources.map((s) => s.value)).toEqual([...DEFAULT_LEAD_SOURCES, 'clubhouse_partner', 'corp_promo'])
    expect(data.sources.find((s) => s.value === 'meta').origin).toBe('default')
    expect(data.sources.find((s) => s.value === 'clubhouse_partner').origin).toBe('studio')
    expect(data.sources.find((s) => s.value === 'corp_promo').origin).toBe('seen')
  })
  it('an owner can edit', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({})
    expect((await (await GET(getReq(), props)).json()).data.can_edit).toBe(true)
  })
  it('no Contacts at the studio is a 403', async () => {
    getCurrentUser.mockResolvedValue(withRole('staff'))
    hasPermissionForLocation.mockReturnValue(false)
    mockDb({})
    expect((await GET(getReq(), props)).status).toBe(403)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(expect.anything(), 'loc1', 'contacts')
  })
  it('a non-member is refused', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, locations: [{ id: 'other' }], rolesByLocation: { other: 'owner' } })
    mockDb({})
    expect((await GET(getReq(), props)).status).toBe(403)
  })
  it('a failed contacts read is a 503, never the defaults alone', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({}, { contactsError: { message: 'boom' } })
    expect((await GET(getReq(), props)).status).toBe(503)
  })
})

describe('PUT', () => {
  it('a manager is refused and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    const written = mockDb({})
    expect((await PUT(putReq({ sources: ['x'] }), props)).status).toBe(403)
    expect(written()).toBeNull()
  })
  it('an owner writes settings.lead_sources trimmed, lowercased and deduped, keeping sibling settings', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb({ glofox: { branch_id: 'x' }, lead_sources: ['old'] })
    const res = await PUT(putReq({ sources: [' Clubhouse_Partner ', 'clubhouse_partner', 'corp-day'] }), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ studio_sources: ['clubhouse_partner', 'corp-day'], can_edit: true })
    expect(written().table).toBe('locations')
    expect(written().patch.settings).toEqual({ glofox: { branch_id: 'x' }, lead_sources: ['clubhouse_partner', 'corp-day'] })
  })
  it('a value with a space, or more than 50, is a 400 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb({})
    expect((await PUT(putReq({ sources: ['Clubhouse Partner'] }), props)).status).toBe(400)
    expect((await PUT(putReq({ sources: Array.from({ length: 51 }, (_, i) => `s${i}`) }), props)).status).toBe(400)
    expect(written()).toBeNull()
  })
  it('a master may write', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {} })
    mockDb({})
    expect((await PUT(putReq({ sources: ['a'] }), props)).status).toBe(200)
  })
})
