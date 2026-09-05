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
vi.mock('@/lib/contact-merge', () => ({
  redactWhatsAppForContact: vi.fn(async () => {}),
  redactInBodyForContact: vi.fn(async () => {}),
  getContactImpact: vi.fn(async () => ({
    cascade_on_delete: [], keep_on_delete: [], redact_on_delete: [], block_delete: [],
    total_rows: 0, partial: false,
  })),
}))
vi.mock('@/lib/contact-mail-erasure', () => ({
  redactMailForContact: vi.fn(async () => ({ ok: true, failures: [], tickets: 0, messages: 0, attachments: 0 })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { PUT, DELETE } from './route.js'
import { requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redactWhatsAppForContact, redactInBodyForContact, getContactImpact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'

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

// DELBLOCK.1 — DELETE ran two irreversible scrubs (WhatsApp PII, InBody
// hard-delete) BEFORE the one statement that can fail. Two FKs reject the
// delete outright — person_groups.primary_contact_id (RESTRICT, NOT NULL) and
// offer_purchases.contact_id (NO ACTION) — so 892 of prod's 8,578 contacts
// could only ever end up scrubbed-but-not-deleted with a raw Postgres error on
// screen. The route now asks getContactImpact what blocks the delete first.
//
// The load-bearing assertion in most of these is NOT the status code: it is
// that redactWhatsAppForContact / redactInBodyForContact were never called.
// A 409 that still scrubbed would be the same data loss with a nicer envelope.
describe('DELETE /api/contacts/[id] — blocker check runs before any destructive work', () => {
  const IMPACT_CLEAN = {
    cascade_on_delete: [], keep_on_delete: [], redact_on_delete: [], block_delete: [],
    total_rows: 0, partial: false,
  }
  const BLOCKER = { table: 'person_groups', column: 'primary_contact_id', label: 'person groups (primary)', count: 3 }

  function deleteDb({ existing = { id: 'c1', location_id: 'loc-1' }, deleteError = null } = {}) {
    const del = vi.fn(() => ({ eq: vi.fn(async () => ({ error: deleteError })) }))
    return {
      delete: del,
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: existing, error: existing ? null : { message: 'no rows' } })) })),
        })),
        delete: del,
      })),
    }
  }

  const delProps = { params: { id: 'c1' } }
  const noDestruction = () => {
    expect(redactWhatsAppForContact).not.toHaveBeenCalled()
    expect(redactInBodyForContact).not.toHaveBeenCalled()
    expect(redactMailForContact).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    getContactImpact.mockResolvedValue(IMPACT_CLEAN)
  })

  it('401 with no session — impact never consulted, nothing scrubbed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(401)
    expect(getContactImpact).not.toHaveBeenCalled()
    noDestruction()
  })

  it('403 for a non-manager role — impact never consulted, nothing scrubbed', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(deleteDb())
    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(403)
    expect(getContactImpact).not.toHaveBeenCalled()
    noDestruction()
  })

  it('404 when the contact does not exist — nothing scrubbed', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(deleteDb({ existing: null }))
    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(404)
    expect(getContactImpact).not.toHaveBeenCalled()
    noDestruction()
  })

  it('403 across locations — the location guard still fires BEFORE the impact check', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-OTHER' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(403)
    expect(getContactImpact).not.toHaveBeenCalled()
    expect(db.delete).not.toHaveBeenCalled()
    noDestruction()
  })

  it('409 when an FK blocks it — and NEITHER scrub ran', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    getContactImpact.mockResolvedValue({ ...IMPACT_CLEAN, block_delete: [BLOCKER], total_rows: 3 })

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/person groups/)
    expect(body.data.block_delete).toEqual([BLOCKER])

    // The whole point of the change.
    noDestruction()
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('refuses (503) when the check itself could not run — partial is not a green light', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    // partial:true means the catalog RPC was unavailable and the legacy
    // 21-pair fallback answered — which can never populate block_delete, so an
    // empty block_delete here proves nothing.
    getContactImpact.mockResolvedValue({ ...IMPACT_CLEAN, partial: true })

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(503)
    expect((await res.json()).data).toEqual({ partial: true })
    noDestruction()
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('refuses (503) when the impact check throws', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    getContactImpact.mockRejectedValue(new Error('boom'))

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(503)
    noDestruction()
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('unblocked contact still scrubs WhatsApp, then InBody, then deletes — in that order', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(200)
    expect(redactWhatsAppForContact).toHaveBeenCalledWith(db, 'c1')
    expect(redactInBodyForContact).toHaveBeenCalledWith(db, 'c1')
    expect(db.delete).toHaveBeenCalled()

    const waOrder = redactWhatsAppForContact.mock.invocationCallOrder[0]
    const inbodyOrder = redactInBodyForContact.mock.invocationCallOrder[0]
    const delOrder = db.delete.mock.invocationCallOrder[0]
    expect(waOrder).toBeLessThan(inbodyOrder)
    expect(inbodyOrder).toBeLessThan(delOrder)
  })

  // MAIL-GDPR.1 — mail joins the scrub. The mail FKs are SET NULL, so the
  // scrub can only find the rows while the contact row still exists: it MUST
  // run before the DELETE, and a clean run keeps the response byte-identical.
  it('scrubs mail BEFORE the delete, and a clean scrub leaves the response unchanged', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(200)
    expect(redactMailForContact).toHaveBeenCalledWith(db, 'c1')
    expect(redactMailForContact.mock.invocationCallOrder[0]).toBeLessThan(db.delete.mock.invocationCallOrder[0])
    expect(await res.json()).toEqual({ success: true })
  })

  it('a partial mail scrub is REPORTED in the response, not swallowed — and the delete still proceeds (WhatsApp doctrine)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    const failure = { table: 'email_inbox_messages', op: 'update', message: 'connection reset' }
    redactMailForContact.mockResolvedValueOnce({ ok: false, failures: [failure], tickets: 1, messages: 3, attachments: 0 })

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(200)
    expect(db.delete).toHaveBeenCalled()
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.scrub_warnings).toEqual([failure])
  })

  it('a mail scrub that THROWS is reported the same way and never blocks the erasure', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    redactMailForContact.mockRejectedValueOnce(new Error('unexpected'))

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(200)
    expect(db.delete).toHaveBeenCalled()
    const body = await res.json()
    expect(body.data.scrub_warnings).toEqual([expect.objectContaining({ table: 'mail', message: expect.stringMatching(/unexpected/) })])
  })

  it('master may delete a contact at any location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'master', locations: [] })
    const db = deleteDb()
    createServerClient.mockReturnValue(db)
    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(200)
    expect(db.delete).toHaveBeenCalled()
  })

  it('still 500s when the delete itself fails — the guard is not a transaction', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    const db = deleteDb({ deleteError: { message: 'update or delete on table "contacts" violates foreign key constraint' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(new Request('http://localhost/api/contacts/c1', { method: 'DELETE' }), delProps)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/foreign key constraint/)
  })
})
