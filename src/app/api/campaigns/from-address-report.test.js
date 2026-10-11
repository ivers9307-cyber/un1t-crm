// FROMDOMAIN — /api/campaigns POST and /api/campaigns/[id] PUT (the per-org
// API-key twins of the editor's routes) store ANY valid from_email as given
// (backward compatible) and report which address it will actually send as:
// the requested one only on the org's VERIFIED sending domain.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ORG1_KEY } from '@/lib/api-auth.test-helpers.js'

const LOCATION = 'a0000000-0000-0000-0000-000000000001'
let inserted = []
let updated = []

const fakeDb = {
  from: () => ({
    insert: (row) => {
      inserted.push(row)
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cam-new', ...row }, error: null }) }) }
    },
    select: () => ({
      eq: () => ({ single: () => Promise.resolve({ data: { status: 'draft', location_id: LOCATION }, error: null }) }),
    }),
    update: (row) => {
      updated.push(row)
      return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'cam-1', location_id: LOCATION, ...row }, error: null }) }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateApiKey: vi.fn(async () => ({ ok: true, orgId: null })),
  assertCreateInOrg: vi.fn(async () => null),
  assertRowInOrg: vi.fn(async () => null),
}))
vi.mock('@/lib/tenant-email', async (importOriginal) => ({ ...(await importOriginal()), resolveEmailSender: vi.fn() }))

import { POST } from './route.js'
import { PUT } from './[id]/route.js'
import { resolveEmailSender } from '@/lib/tenant-email'

const LIVE_UN1T = { serverToken: 'srv-tok', fromEmail: 'hello@un1tdublin.com', fromName: 'UN1T', replyTo: null, sendingDomain: 'un1tdublin.com' }
const PRE_DOMAIN = { serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Gym A', replyTo: null }

const headers = { 'content-type': 'application/json', authorization: `Bearer ${ORG1_KEY}` }
const post = (extra) => POST(new Request('http://localhost/api/campaigns', {
  method: 'POST', headers, body: JSON.stringify({ location_id: LOCATION, name: 'Sale', ...extra }),
}))
const put = (body) => PUT(new Request('http://localhost/api/campaigns/cam-1', {
  method: 'PUT', headers, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: 'cam-1' }) })

beforeEach(() => {
  inserted = []; updated = []
  vi.clearAllMocks()
  resolveEmailSender.mockResolvedValue({ ...LIVE_UN1T })
})

describe('POST /api/campaigns — from_email (FROMDOMAIN)', () => {
  it('on the verified domain: stored, and reported as the address it sends as', async () => {
    const res = await post({ from_email: 'garrett@un1tdublin.com' })
    expect(res.status).toBe(200)
    expect(inserted[0].from_email).toBe('garrett@un1tdublin.com')
    expect(resolveEmailSender).toHaveBeenCalledWith(fakeDb, LOCATION)
    const json = await res.json()
    expect(json.from_address).toEqual({ requested: 'garrett@un1tdublin.com', sends_as: 'garrett@un1tdublin.com', on_verified_domain: true, verified_domain: 'un1tdublin.com' })
    expect(JSON.stringify(json)).not.toContain('srv-tok')
  })

  it('another domain: still stored as given (no 400), reported as ignored', async () => {
    const res = await post({ from_email: 'x@other.com' })
    expect(res.status).toBe(200)
    expect(inserted[0].from_email).toBe('x@other.com')
    expect((await res.json()).from_address).toMatchObject({ sends_as: 'hello@un1tdublin.com', on_verified_domain: false })
  })

  it('no live domain: the platform address whatever was requested', async () => {
    resolveEmailSender.mockResolvedValue({ ...PRE_DOMAIN })
    const json = await (await post({ from_email: 'garrett@un1tdublin.com' })).json()
    expect(json.from_address).toEqual({ requested: 'garrett@un1tdublin.com', sends_as: 'hello@platform.test', on_verified_domain: false, verified_domain: null })
  })

  it('an invalid address is still a 400 (the existing schema), nothing written', async () => {
    const res = await post({ from_email: 'not an address' })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('no from_email: no from_address key, no resolver call', async () => {
    const json = await (await post({})).json()
    expect(json.success).toBe(true)
    expect(json).not.toHaveProperty('from_address')
    expect(resolveEmailSender).not.toHaveBeenCalled()
  })
})

describe('PUT /api/campaigns/[id] — from_email (FROMDOMAIN)', () => {
  it('reports the address it sends as, judged at the campaign\'s location; stored as given', async () => {
    const res = await put({ from_email: 'Alex@UN1TDublin.com' })
    expect(res.status).toBe(200)
    expect(updated[0].from_email).toBe('Alex@UN1TDublin.com')
    expect(resolveEmailSender).toHaveBeenCalledWith(fakeDb, LOCATION)
    expect((await res.json()).from_address).toMatchObject({ sends_as: 'alex@un1tdublin.com', on_verified_domain: true })
  })

  it('a subdomain is not the verified domain', async () => {
    const json = await (await put({ from_email: 'alex@mail.un1tdublin.com' })).json()
    expect(json.from_address).toMatchObject({ sends_as: 'hello@un1tdublin.com', on_verified_domain: false })
  })

  it('an update without from_email carries no from_address', async () => {
    const json = await (await put({ name: 'Renamed' })).json()
    expect(json).not.toHaveProperty('from_address')
    expect(resolveEmailSender).not.toHaveBeenCalled()
  })
})
