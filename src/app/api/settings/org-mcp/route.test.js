// MCP.1 Task 10 — the organisation switch for the staff MCP server.
// @/lib/auth is the REAL module with only getCurrentUser mocked (as the
// org-branding test), so the org-admin rule under test is the real one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG = 'c0000000-0000-0000-0000-000000000001'
const OTHER_ORG = 'c0000000-0000-0000-0000-000000000002'
const LOC = 'a0000000-0000-0000-0000-000000000001'

const base = { locations: [{ id: LOC, organization_id: ORG }], activeLocation: { id: LOC, organization_id: ORG }, activeOrganization: { id: ORG } }
const ORG_ADMIN = { id: 'u-admin', role: 'owner', orgAdminOrgIds: [ORG], rolesByLocation: { [LOC]: 'owner' }, ...base }
const STUDIO_OWNER = { id: 'u-owner', role: 'owner', orgAdminOrgIds: [], rolesByLocation: { [LOC]: 'owner' }, ...base }

function makeDb({ settings = { mcp_enabled: true }, calls = [], upsertError = null, readError = null } = {}) {
  const log = { upserts: [], selects: [], filters: [] }
  return {
    log,
    from(table) {
      const b = {
        upsert: (payload, opts) => { log.upserts.push({ table, payload, opts }); return b },
        select: (cols) => { log.selects.push({ table, cols }); return b },
        eq: (c, v) => { log.filters.push({ table, op: 'eq', c, v }); return b },
        gte: (c, v) => { log.filters.push({ table, op: 'gte', c, v }); return b },
        order: () => b,
        range: () => b,
        maybeSingle: () => Promise.resolve({ data: readError ? null : settings, error: readError }),
        single: () => Promise.resolve({
          data: upsertError ? null : { mcp_enabled: log.upserts.at(-1)?.payload.mcp_enabled },
          error: upsertError,
        }),
        then: (res, rej) => Promise.resolve(
          table === 'mcp_tool_calls' ? { data: calls, error: null } : { data: null, error: null },
        ).then(res, rej),
      }
      return b
    },
  }
}

const put = (body) => new Request('http://localhost/api/settings/org-mcp', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const get = (qs = '') => new Request(`http://localhost/api/settings/org-mcp${qs}`)

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.test/'
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(ORG_ADMIN)
})
afterEach(() => { delete process.env.NEXT_PUBLIC_APP_URL })

describe('PUT /api/settings/org-mcp', () => {
  it('401s with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(put({ enabled: true }))).status).toBe(401)
  })

  it('refuses a studio owner who is not an org admin (403)', async () => {
    getCurrentUser.mockResolvedValue(STUDIO_OWNER)
    const res = await PUT(put({ organization_id: ORG, enabled: true }))
    expect(res.status).toBe(403)
    expect(db.log.upserts).toEqual([])
  })

  it('refuses an org admin targeting an organisation they do not administer (403, nothing written)', async () => {
    const res = await PUT(put({ organization_id: OTHER_ORG, enabled: true }))
    expect(res.status).toBe(403)
    expect(db.log.upserts).toEqual([])
  })

  it('400s a body without a boolean enabled', async () => {
    const res = await PUT(put({ organization_id: ORG, enabled: 'yes' }))
    expect(res.status).toBe(400)
    expect(db.log.upserts).toEqual([])
  })

  it('writes mcp_enabled and updated_by for an org admin, upserting on organization_id', async () => {
    const res = await PUT(put({ organization_id: ORG, enabled: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { mcp_enabled: true } })
    expect(db.log.upserts).toHaveLength(1)
    const { payload, opts } = db.log.upserts[0]
    expect(payload).toMatchObject({ organization_id: ORG, mcp_enabled: true, updated_by: 'u-admin' })
    expect(opts).toEqual({ onConflict: 'organization_id' })
  })

  it('defaults to the active organisation and can switch off', async () => {
    const res = await PUT(put({ enabled: false }))
    expect(res.status).toBe(200)
    expect(db.log.upserts[0].payload).toMatchObject({ organization_id: ORG, mcp_enabled: false })
  })

  it('answers 500 (not success) when the write fails', async () => {
    db = makeDb({ upsertError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ organization_id: ORG, enabled: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})

describe('GET /api/settings/org-mcp', () => {
  it('401s with no session and 403s a studio owner', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get())).status).toBe(401)
    getCurrentUser.mockResolvedValue(STUDIO_OWNER)
    expect((await GET(get(`?organization_id=${ORG}`))).status).toBe(403)
  })

  it('GET counts distinct people in 30 days and returns the connector URL', async () => {
    db = makeDb({ settings: { mcp_enabled: true }, calls: [{ profile_id: 'p1' }, { profile_id: 'p1' }, { profile_id: 'p2' }] })
    createServerClient.mockReturnValue(db)
    const res = await GET(get(`?organization_id=${ORG}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { organization_id: ORG, mcp_enabled: true, connector_url: 'https://crm.example.test/api/mcp', people_30d: 2 },
    })
    const callsFilters = db.log.filters.filter((f) => f.table === 'mcp_tool_calls')
    expect(callsFilters).toContainEqual({ table: 'mcp_tool_calls', op: 'eq', c: 'organization_id', v: ORG })
    expect(callsFilters.some((f) => f.op === 'gte' && f.c === 'created_at')).toBe(true)
    expect(db.log.selects.every((s) => s.cols !== '*')).toBe(true)
  })

  it('an organisation with no org_settings row yet is off', async () => {
    db = makeDb({ settings: null })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(get())).json()
    expect(body.data.mcp_enabled).toBe(false)
    expect(body.data.people_30d).toBe(0)
  })

  it('500s when a read fails, never reporting "off"', async () => {
    db = makeDb({ readError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
