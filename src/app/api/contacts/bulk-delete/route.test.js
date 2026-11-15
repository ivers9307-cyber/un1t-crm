// MAIL-GDPR.1 — the bulk erasure path scrubs the same three channels as the
// single delete (WhatsApp, InBody, mail), per contact, BEFORE each contact row
// goes. Mail is new here; its partial failures are reported per contact in
// `scrub_warnings` rather than swallowed, and the delete still proceeds — the
// same best-effort doctrine the WhatsApp scrub has always had on this route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ROLESWEEP.1c — the REAL per-location role helpers (pure: role-at-location).
vi.mock('@/lib/auth', async () => ({ ...(await vi.importActual('@/lib/role-at-location')), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-merge', () => ({
  redactWhatsAppForContact: vi.fn(async () => {}),
  redactInBodyForContact: vi.fn(async () => {}),
  getContactImpact: vi.fn(async () => ({ partial: false, block_delete: [] })),
}))
vi.mock('@/lib/revolut-customers', () => ({ forgetRevolutCustomerForContact: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-mail-erasure', () => ({
  redactMailForContact: vi.fn(async () => ({ ok: true, failures: [], tickets: 0, messages: 0, attachments: 0 })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { redactWhatsAppForContact, redactInBodyForContact, getContactImpact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'

const C1 = 'c0000000-0000-4000-8000-000000000001'
const C2 = 'c0000000-0000-4000-8000-000000000002'

function bulkDb(rows, { deleteError = null, readError = null } = {}) {
  const del = vi.fn(() => ({ eq: vi.fn(async () => ({ error: deleteError })) }))
  return {
    delete: del,
    from: vi.fn(() => ({
      select: vi.fn(() => ({ in: vi.fn(async () => ({ data: readError ? null : rows, error: readError })) })),
      delete: del,
    })),
  }
}

const req = (ids) => new Request('http://localhost/api/contacts/bulk-delete', {
  method: 'POST',
  body: JSON.stringify({ contact_ids: ids }),
  headers: { 'Content-Type': 'application/json' },
})

beforeEach(() => {
  vi.clearAllMocks()
  getContactImpact.mockResolvedValue({ partial: false, block_delete: [] })
  getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
})

describe('POST /api/contacts/bulk-delete — mail scrub per contact', () => {
  it('scrubs WhatsApp, InBody and mail for each contact before its delete', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-1' }, { id: C2, name: 'B', location_id: 'loc-1' }])
    createServerClient.mockReturnValue(db)

    const res = await POST(req([C1, C2]))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.deleted).toBe(2)
    expect(redactWhatsAppForContact).toHaveBeenCalledTimes(2)
    expect(redactInBodyForContact).toHaveBeenCalledTimes(2)
    expect(redactMailForContact).toHaveBeenCalledWith(db, C1)
    expect(redactMailForContact).toHaveBeenCalledWith(db, C2)
    // Mail scrub runs before the row goes — the SET NULL FK makes it unfindable after.
    expect(redactMailForContact.mock.invocationCallOrder[0]).toBeLessThan(db.delete.mock.invocationCallOrder[0])
    // Byte-identical to the pre-MAIL-GDPR.1 shape on a clean run — the key
    // appears only when there is something to act on, as on the single route.
    expect(data).not.toHaveProperty('scrub_warnings')
    expect(Object.keys(data).sort()).toEqual(['blocked', 'deleted', 'forbidden', 'missing', 'requested'])
  })

  it('reports a partial mail scrub against the contact it belongs to, and still deletes', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-1' }, { id: C2, name: 'B', location_id: 'loc-1' }])
    createServerClient.mockReturnValue(db)
    const failure = { table: 'email_tickets', op: 'update', message: 'boom' }
    redactMailForContact
      .mockResolvedValueOnce({ ok: true, failures: [] })
      .mockResolvedValueOnce({ ok: false, failures: [failure] })

    const { data } = await (await POST(req([C1, C2]))).json()
    expect(data.deleted).toBe(2)
    expect(data.scrub_warnings).toEqual([{ id: C2, name: 'B', failures: [failure] }])
  })

  it('does not scrub a contact at another location (nothing destructive before the guard)', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-other' }])
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req([C1]))).json()
    expect(data.forbidden).toHaveLength(1)
    expect(redactMailForContact).not.toHaveBeenCalled()
    expect(db.delete).not.toHaveBeenCalled()
  })
})

// DELBLOCK.2 — audit 2026-11-15 item 4: the single route refuses a blocked
// contact BEFORE scrubbing; the bulk route scrubbed first and deleted after,
// so a refused delete left the contact in place with its history stripped.
describe('POST /api/contacts/bulk-delete — blocker check before any scrub', () => {
  const PRIMARY = [{ table: 'person_groups', column: 'primary_contact_id', count: 1, label: 'linked person group (this is its primary)' }]

  it('a blocked contact is refused with no scrub and no delete; the others still go', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-1' }, { id: C2, name: 'B', location_id: 'loc-1' }])
    createServerClient.mockReturnValue(db)
    getContactImpact.mockImplementation(async (_db, id) => ({ partial: false, block_delete: id === C1 ? PRIMARY : [] }))

    const { data } = await (await POST(req([C1, C2]))).json()
    expect(data.deleted).toBe(1)
    expect(data.blocked).toHaveLength(1)
    expect(data.blocked[0]).toMatchObject({ id: C1, block_delete: PRIMARY })
    expect(data.blocked[0].reason).toMatch(/Reassign or remove those first/)
    for (const scrub of [redactWhatsAppForContact, redactInBodyForContact, redactMailForContact]) {
      expect(scrub).toHaveBeenCalledTimes(1)
      expect(scrub.mock.calls[0][1]).toBe(C2)
    }
    expect(db.delete).toHaveBeenCalledTimes(1)
  })

  it('fails closed: an impact check that could not look (partial) or threw refuses that contact untouched', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-1' }, { id: C2, name: 'B', location_id: 'loc-1' }])
    createServerClient.mockReturnValue(db)
    getContactImpact
      .mockResolvedValueOnce({ partial: true, block_delete: [] })
      .mockRejectedValueOnce(new Error('rpc down'))

    const { data } = await (await POST(req([C1, C2]))).json()
    expect(data.deleted).toBe(0)
    expect(data.blocked.map((b) => b.id)).toEqual([C1, C2])
    expect(data.blocked[0].reason).toMatch(/Could not check/)
    expect(redactWhatsAppForContact).not.toHaveBeenCalled()
    expect(redactInBodyForContact).not.toHaveBeenCalled()
    expect(redactMailForContact).not.toHaveBeenCalled()
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('the impact check runs only after the location and role checks', async () => {
    const db = bulkDb([{ id: C1, name: 'A', location_id: 'loc-other' }])
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req([C1]))).json()
    expect(data.forbidden).toHaveLength(1)
    expect(getContactImpact).not.toHaveBeenCalled()
  })

  it('a failed contacts read answers 500 and touches nothing (not "all missing")', async () => {
    const db = bulkDb([], { readError: { code: '57014', message: 'timeout' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req([C1, C2]))
    expect(res.status).toBe(500)
    expect(redactWhatsAppForContact).not.toHaveBeenCalled()
    expect(db.delete).not.toHaveBeenCalled()
  })
})
