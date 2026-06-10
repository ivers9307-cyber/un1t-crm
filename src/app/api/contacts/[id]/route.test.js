// Tests for PUT /api/contacts/[id] — the cookie-path location gate
// (2026-06-10 audit). assertRowInOrg only scopes per-org API keys (it
// no-ops when orgId is null), so the cookie path previously let a
// manager at one studio update any contact at any location/org by id.
// The route now mirrors the DELETE handler's location guard; the
// legacy-key (orgId null, user null) path stays unscoped by design.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(),
  requireApiKeyOrManager: vi.fn(),
  assertRowInOrg: vi.fn(async () => null),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForTagsAdded: vi.fn(async () => {}) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-merge', () => ({ redactWhatsAppForContact: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { PUT } from './route.js'
import { requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'

function mockDb({ oldRow, updated } = {}) {
  const updateSingle = vi.fn(() =>
    Promise.resolve({ data: updated ?? { id: 'c1', ...oldRow }, error: null })
  )
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({ select: vi.fn(() => ({ single: updateSingle })) })),
  }))
  return {
    update,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() =>
            Promise.resolve(
              oldRow
                ? { data: oldRow, error: null }
                : { data: null, error: { message: 'no rows' } }
            )
          ),
        })),
      })),
      update,
    })),
  }
}

const req = (body = { first_name: 'Ada' }) =>
  new Request('http://localhost/api/contacts/c1', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
const props = { params: { id: 'c1' } }

beforeEach(() => {
  vi.clearAllMocks()
  assertRowInOrg.mockResolvedValue(null)
})

describe('PUT /api/contacts/[id] — cookie-path location gate', () => {
  it('404 when a cookie manager targets a contact at another location — update blocked', async () => {
    requireApiKeyOrManager.mockResolvedValue({
      ok: true,
      orgId: null,
      user: { role: 'manager', locations: [{ id: 'loc-OTHER' }] },
    })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req(), props)
    expect(res.status).toBe(404)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('updates when the cookie manager is assigned to the contact location', async () => {
    requireApiKeyOrManager.mockResolvedValue({
      ok: true,
      orgId: null,
      user: { role: 'manager', locations: [{ id: 'loc-1' }] },
    })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req(), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalled()
  })

  it('master may update a contact at any location', async () => {
    requireApiKeyOrManager.mockResolvedValue({
      ok: true,
      orgId: null,
      user: { role: 'master', locations: [] },
    })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req(), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalled()
  })

  it('per-org API key stays scoped via assertRowInOrg (404 outside the org)', async () => {
    requireApiKeyOrManager.mockResolvedValue({ ok: true, orgId: 'org-1', user: null })
    assertRowInOrg.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'not_found' }), { status: 404 })
    )
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req(), props)
    expect(res.status).toBe(404)
    expect(assertRowInOrg).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', table: 'contacts', id: 'c1' })
    )
    expect(db.update).not.toHaveBeenCalled()
  })

  it('legacy shared key (orgId null, no user) stays unscoped — n8n back-compat', async () => {
    requireApiKeyOrManager.mockResolvedValue({ ok: true, orgId: null, user: null })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req(), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalled()
  })

  it('401 passthrough when auth fails', async () => {
    requireApiKeyOrManager.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }),
    })
    const res = await PUT(req(), props)
    expect(res.status).toBe(401)
  })
})
