// MAIL-GDPR.1 — the bulk erasure path scrubs the same three channels as the
// single delete (WhatsApp, InBody, mail), per contact, BEFORE each contact row
// goes. Mail is new here; its partial failures are reported per contact in
// `scrub_warnings` rather than swallowed, and the delete still proceeds — the
// same best-effort doctrine the WhatsApp scrub has always had on this route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-merge', () => ({
  redactWhatsAppForContact: vi.fn(async () => {}),
  redactInBodyForContact: vi.fn(async () => {}),
}))
vi.mock('@/lib/contact-mail-erasure', () => ({
  redactMailForContact: vi.fn(async () => ({ ok: true, failures: [], tickets: 0, messages: 0, attachments: 0 })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { redactWhatsAppForContact, redactInBodyForContact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'

const C1 = 'c0000000-0000-4000-8000-000000000001'
const C2 = 'c0000000-0000-4000-8000-000000000002'

function bulkDb(rows, { deleteError = null } = {}) {
  const del = vi.fn(() => ({ eq: vi.fn(async () => ({ error: deleteError })) }))
  return {
    delete: del,
    from: vi.fn(() => ({
      select: vi.fn(() => ({ in: vi.fn(async () => ({ data: rows, error: null })) })),
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
  getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
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
    expect(data.scrub_warnings).toEqual([])
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
