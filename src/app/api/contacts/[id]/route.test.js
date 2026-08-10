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

// HOST-MASTER.6b — automations_exempt (mig 464) is a staff decision: the
// cookie path (Manager+ by requireApiKeyOrManager) may flip it; API-key
// callers (auth.user null — n8n / integrations) get the field stripped
// rather than 403'd so whole-object PUTs keep working.
describe('PUT /api/contacts/[id] — automations_exempt gating', () => {
  it('strips automations_exempt for an API-key caller (user null) — update object lacks it', async () => {
    requireApiKeyOrManager.mockResolvedValue({ ok: true, orgId: null, user: null })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ first_name: 'Ada', automations_exempt: true }), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalledWith({ first_name: 'Ada' })
    expect(db.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ automations_exempt: true })
    )
  })

  it('passes automations_exempt through for a cookie Manager+ caller', async () => {
    requireApiKeyOrManager.mockResolvedValue({
      ok: true,
      orgId: null,
      user: { role: 'manager', locations: [{ id: 'loc-1' }] },
    })
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: null, glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ automations_exempt: false }), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalledWith({ automations_exempt: false })
  })
})

// EMAILREP.1 — contacts.email_status is reputation for a MAILBOX, and
// nothing reset it when the mailbox changed. Every send path blocks on
// it (marketing + transactional audiences, campaign sender, manual staff
// email, booking + event reminders), so a contact whose typo'd address
// hard-bounced stayed permanently unmailable after staff corrected it —
// no error, just a greyed-out button. The reset rides the SAME update as
// the address change.
describe('PUT /api/contacts/[id] — email_status reset on address change (EMAILREP.1)', () => {
  const asManager = () => requireApiKeyOrManager.mockResolvedValue({
    ok: true, orgId: null, user: { role: 'manager', locations: [{ id: 'loc-1' }] },
  })

  it('clears a bounce when staff correct the address', async () => {
    asManager()
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: 'typo@gmial.com', email_status: 'bounced', glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ email: 'real@gmail.com' }), props)
    expect(res.status).toBe(200)
    expect(db.update).toHaveBeenCalledWith({ email: 'real@gmail.com', email_status: 'active' })
  })

  it('clears a complaint when the address is replaced', async () => {
    asManager()
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: 'old@x.com', email_status: 'complained', glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ email: 'new@x.com' }), props)
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ email_status: 'active' }))
  })

  it('does NOT clear the bounce when the update leaves the address alone', async () => {
    asManager()
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: 'a@x.com', email_status: 'bounced', glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ first_name: 'Ada' }), props)
    expect(db.update).toHaveBeenCalledWith({ first_name: 'Ada' })
  })

  it('does NOT clear the bounce on a casing-only re-save of the same address', async () => {
    asManager()
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: 'Ann@X.com', email_status: 'bounced', glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ email: 'ann@x.com' }), props)
    expect(db.update).toHaveBeenCalledWith({ email: 'ann@x.com' })
  })

  // The load-bearing half: an address change restores REPUTATION, never
  // CONSENT. The hard-bounce handler revoked email_marketing when it
  // stamped 'bounced'; a corrected address must not silently re-add the
  // contact to a marketing audience.
  it('never writes a consent field alongside the reset', async () => {
    asManager()
    const db = mockDb({ oldRow: { tags: [], location_id: 'loc-1', email: 'a@x.com', email_status: 'bounced', glofox_member_id: null } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ email: 'b@x.com' }), props)
    const written = db.update.mock.calls[0][0]
    expect(written).toEqual({ email: 'b@x.com', email_status: 'active' })
    for (const k of ['email_marketing', 'email_administrative', 'email_suppressed_at']) {
      expect(written).not.toHaveProperty(k)
    }
  })
})
