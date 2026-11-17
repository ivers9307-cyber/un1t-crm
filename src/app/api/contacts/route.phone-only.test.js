// PHONEONLY.1 — POST /api/contacts takes an email OR a phone. Without an
// email there is no unique index, so the route looks for the same WhatsApp
// number in the organisation first; a failed check refuses the create.
// Synthetic data only (public repo).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForPipelineStageChange: vi.fn(async () => {}) }))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn() }))
vi.mock('@/lib/push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn(async () => {}) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
const { POST } = await import('./route.js')

const LOC = 'a0000000-0000-4000-8000-000000000001'
const LOC2 = 'a0000000-0000-4000-8000-000000000002'
const ORG = 'o0000000-0000-4000-8000-000000000001'
const MANAGER = {
  id: 'u1', role: 'manager', isMaster: false,
  activeLocation: { id: LOC }, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' },
  user: { id: 'u1', email: 'manager@example.com' },
}
const post = (body) => new Request('http://localhost/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function fakeDb({ dupRows = [], dupError = null, orgError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'in', 'limit', 'insert']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      b.maybeSingle = () => Promise.resolve(table === 'locations' ? { data: { organization_id: ORG }, error: null } : { data: null, error: null })
      b.single = () => Promise.resolve({ data: { id: 'new-1', location_id: LOC, email: q.ops.find((o) => o[0] === 'insert')?.[1]?.email ?? null, pipeline_stage_slug: null }, error: null })
      b.then = (res, rej) => {
        let out = { data: [], error: null }
        if (table === 'locations') out = orgError ? { data: null, error: orgError } : { data: [{ id: LOC }, { id: LOC2 }], error: null }
        if (table === 'contacts') out = dupError ? { data: null, error: dupError } : { data: dupRows, error: null }
        return Promise.resolve(out).then(res, rej)
      }
      return b
    },
  }
}
const inserts = (db) => db.calls.filter((c) => c.table === 'contacts').flatMap((c) => c.ops.filter((o) => o[0] === 'insert'))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
})

describe('POST /api/contacts — phone-only (PHONEONLY.1)', () => {
  it('creates a contact with a phone and no email, after checking the whole organisation for the number', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ name: 'Walk In', phone: '087 123 4567' }))
    expect(res.status).toBe(200)
    expect(inserts(db)[0][1]).toMatchObject({ email: null, phone: '087 123 4567' })
    const dupRead = db.calls.find((c) => c.table === 'contacts' && c.ops.some((o) => o[0] === 'eq' && o[1] === 'wa_phone'))
    expect(dupRead.ops).toContainEqual(['eq', 'wa_phone', '353871234567'])
    expect(dupRead.ops).toContainEqual(['in', 'location_id', [LOC, LOC2]])
    // No email: never sent to Glofox lead provisioning.
    expect(maybeProvisionLeadInGlofox).not.toHaveBeenCalled()
  })

  it('409 when the organisation already has that number', async () => {
    const db = fakeDb({ dupRows: [{ id: 'existing' }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(post({ name: 'Walk In', phone: '+353 87 123 4567' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/phone number already exists/)
    expect(inserts(db)).toEqual([])
  })

  it('a failed duplicate check refuses the create, never a silent duplicate', async () => {
    for (const opts of [{ dupError: { message: 'boom' } }, { orgError: { message: 'boom' } }]) {
      const db = fakeDb(opts)
      createServerClient.mockReturnValue(db)
      expect((await POST(post({ name: 'Walk In', phone: '0871234567' }))).status).toBe(500)
      expect(inserts(db)).toEqual([])
    }
  })

  it('400 with neither an email nor a phone', async () => {
    createServerClient.mockReturnValue(fakeDb())
    const res = await POST(post({ name: 'Nobody' }))
    expect(res.status).toBe(400)
  })

  it('an email contact skips the phone check (the unique index guards it)', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(post({ name: 'Member One', email: 'member.one@example.com', phone: '0871234567' }))).status).toBe(200)
    expect(db.calls.some((c) => c.table === 'contacts' && c.ops.some((o) => o[1] === 'wa_phone'))).toBe(false)
  })
})
