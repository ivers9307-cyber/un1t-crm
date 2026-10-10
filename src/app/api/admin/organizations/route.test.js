// W1.L1 — POST /api/admin/organizations creates the org AND its automatic
// platform host (<slug>.repset.ie, tenant_domains source='platform', mig 716).
// Auth is mocked at getCurrentUser; supabase is the filter-aware in-memory
// double (Style A, as the tenant-domains route test).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
let currentUser
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => currentUser) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { logError } from '@/lib/log'

const MASTER = { id: 'u-master', profileRole: 'master' }
const OWNER = { id: 'u-owner', profileRole: 'owner' }
const NEW_ORG_ID = 'a0000000-0000-0000-0000-0000000000a1'

const postReq = (body) =>
  new Request('http://localhost/api/admin/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** makeFakeDb with an id stamped on organizations inserts (the DB default). */
function makeDb(tables, { hostInsertError = null } = {}) {
  const base = makeFakeDb(tables)
  return {
    from(table) {
      const b = base.from(table)
      if (table === 'organizations') {
        const insert = b.insert
        b.insert = (row) => insert({ id: NEW_ORG_ID, active: true, ...row })
      }
      if (table === 'tenant_domains' && hostInsertError) {
        b.insert = () => ({ then: (res) => Promise.resolve({ data: null, error: hostInsertError }).then(res) })
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb({ organizations: [], tenant_domains: [] })
  currentUser = MASTER
})

describe('auth (401 / 403)', () => {
  it('no session → 401; non-master → 403; nothing inserted', async () => {
    currentUser = null
    expect((await POST(postReq({ name: 'Acme Gyms' }))).status).toBe(401)
    currentUser = OWNER
    expect((await POST(postReq({ name: 'Acme Gyms' }))).status).toBe(403)
    expect((await db.from('organizations').select('id')).data).toEqual([])
    expect((await db.from('tenant_domains').select('id')).data).toEqual([])
  })
})

describe('POST — the org and its platform host are born together', () => {
  it('inserts the org, then one tenant_domains row <slug>.repset.ie, source=platform', async () => {
    const res = await POST(postReq({ name: 'Acme Gyms' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.slug).toBe('acme-gyms')

    const orgs = (await db.from('organizations').select('*')).data
    expect(orgs).toHaveLength(1)
    const hosts = (await db.from('tenant_domains').select('*')).data
    expect(hosts).toEqual([{
      hostname: 'acme-gyms.repset.ie',
      organization_id: NEW_ORG_ID,
      brand: {},
      active: true,
      source: 'platform',
    }])
    expect(logError).not.toHaveBeenCalled()
  })

  it('an explicit slug names the host', async () => {
    const res = await POST(postReq({ name: 'Acme Gyms', slug: 'acme' }))
    expect(res.status).toBe(200)
    const hosts = (await db.from('tenant_domains').select('hostname')).data
    expect(hosts.map((r) => r.hostname)).toEqual(['acme.repset.ie'])
  })

  it('a failed host insert is logged, not fatal — the org is already committed', async () => {
    db = makeDb({ organizations: [], tenant_domains: [] }, { hostInsertError: { message: 'boom' } })
    const res = await POST(postReq({ name: 'Acme Gyms' }))
    expect(res.status).toBe(200)
    expect((await db.from('organizations').select('id')).data).toHaveLength(1)
    expect(logError).toHaveBeenCalledWith(
      'organizations.create.platform_host',
      'boom',
      expect.objectContaining({ orgId: NEW_ORG_ID, hostname: 'acme-gyms.repset.ie' }),
    )
  })

  it('invalid body → 400, nothing inserted', async () => {
    const res = await POST(postReq({ name: '' }))
    expect(res.status).toBe(400)
    expect((await db.from('tenant_domains').select('id')).data).toEqual([])
  })
})
