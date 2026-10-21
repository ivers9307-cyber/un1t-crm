// ORGCONTACTS.4 (decision 4) — POST /api/contacts/[id]/primary-studio
// { location_id }: move a contact's primary studio to another studio the
// person has a relationship with, inside its organisation. Gated like delete
// (the primary studio's admins, an organisation admin, a master); 404 for a
// contact the caller cannot view; 400 no_relationship / other_organisation.
// Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-crossovers', () => ({ canViewContact: vi.fn(async () => true) }))
vi.mock('@/lib/contact-studios', () => ({ hasRelationshipAt: vi.fn(async () => ({ ok: true, at: new Set() })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { canViewContact } from '@/lib/contact-crossovers'
import { hasRelationshipAt } from '@/lib/contact-studios'
import { person, MASTER, LOC_A, LOC_B, LOC_OTHER, ORG } from '../../../../../../tests/helpers/role-sweep-callers.js'

const ID = 'c0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000ff'
const LOC_Z = 'e0000000-0000-4000-8000-00000000000e' // another organisation's studio
const CONTACT = { id: ID, location_id: LOC_A, organization_id: ORG }

function fakeDb({ contact = CONTACT, locations = { [LOC_A]: ORG, [LOC_B]: ORG, [LOC_Z]: OTHER_ORG }, updateRows = [{ id: ID }], updateError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      const st = { filters: [], patch: null }
      const b = {
        select() { return b },
        eq(c, v) { st.filters.push([c, v]); return b },
        update(patch) { st.patch = patch; return b },
        async single() {
          if (table === 'contacts') return contact ? { data: contact, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          throw new Error(`unexpected single on ${table}`)
        },
        async maybeSingle() {
          if (table === 'locations') { const id = st.filters.find(([c]) => c === 'id')?.[1]; return { data: id in locations ? { id, organization_id: locations[id] } : null, error: null } }
          throw new Error(`unexpected maybeSingle on ${table}`)
        },
        then(res, rej) {
          if (st.patch) { updates.push({ table, patch: st.patch, filters: st.filters }); return Promise.resolve(updateError ? { data: null, error: updateError } : { data: updateRows, error: null }).then(res, rej) }
          return Promise.resolve({ data: [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}
const req = (body) => new Request(`http://localhost/api/contacts/${ID}/primary-studio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: { id: ID } }
const managerAt = (loc) => person({ [loc]: { role: 'manager', permissions: { contacts: true } } }, loc)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
  canViewContact.mockResolvedValue(true)
  hasRelationshipAt.mockResolvedValue({ ok: true, at: new Set([LOC_A, LOC_B]) })
  getCurrentUser.mockResolvedValue(managerAt(LOC_A))
})

describe('POST /api/contacts/[id]/primary-studio', () => {
  it("the primary studio's manager moves the primary to a studio with a relationship: 200, the column moves", async () => {
    const res = await POST(req({ location_id: LOC_B }), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { location_id: LOC_B } })
    expect(db.updates).toEqual([{ table: 'contacts', patch: { location_id: LOC_B }, filters: [['id', ID]] }])
    expect(hasRelationshipAt).toHaveBeenCalledWith(db, ID, [LOC_B])
  })

  it('an organisation admin and a master may too; a relationship studio’s manager may not (403)', async () => {
    getCurrentUser.mockResolvedValue({ ...person({}, LOC_OTHER), locations: [], rolesByLocation: {}, orgAdminOrgIds: [ORG] })
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(200)
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(200)
    getCurrentUser.mockResolvedValue(managerAt(LOC_B))
    const res = await POST(req({ location_id: LOC_B }), props)
    expect(res.status).toBe(403)
    expect(db.updates.filter((u) => u.table === 'contacts')).toHaveLength(2)
  })

  it('401 signed out; 404 for a missing contact or one the caller cannot view (never 403, so ids cannot be enumerated)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(401)
    getCurrentUser.mockResolvedValue(managerAt(LOC_A))
    createServerClient.mockReturnValue(fakeDb({ contact: null }))
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(404)
    createServerClient.mockReturnValue(fakeDb())
    canViewContact.mockResolvedValue(false)
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(404)
  })

  it('400 no_relationship when the person has no contact_studios row at the target; 503 when that read fails', async () => {
    hasRelationshipAt.mockResolvedValue({ ok: true, at: new Set([LOC_A]) })
    const res = await POST(req({ location_id: LOC_B }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no_relationship')
    hasRelationshipAt.mockResolvedValue({ ok: false, error: 'down' })
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(503)
    expect(db.updates).toEqual([])
  })

  it("400 other_organisation for a studio outside the contact's organisation, or an unknown studio", async () => {
    hasRelationshipAt.mockResolvedValue({ ok: true, at: new Set([LOC_A, LOC_B, LOC_Z]) })
    const res = await POST(req({ location_id: LOC_Z }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('other_organisation')
    const unknown = await POST(req({ location_id: '99999999-0000-4000-8000-000000000099' }), props)
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toBe('other_organisation')
    expect(db.updates).toEqual([])
  })

  it('400 on a malformed body; the current primary is a no-op 200 with no write', async () => {
    expect((await POST(req({ location_id: 'nope' }), props)).status).toBe(400)
    const res = await POST(req({ location_id: LOC_A }), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { location_id: LOC_A } })
    expect(db.updates).toEqual([])
  })

  it('a failed write is a 500 with no Postgres text; a write that touched no row is a 404', async () => {
    createServerClient.mockReturnValue(fakeDb({ updateError: { message: 'duplicate key value violates "secret_index"' } }))
    const res = await POST(req({ location_id: LOC_B }), props)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/secret_index/)
    createServerClient.mockReturnValue(fakeDb({ updateRows: [] }))
    expect((await POST(req({ location_id: LOC_B }), props)).status).toBe(404)
  })
})
