// CONTACTEXPORT.1 — owners and masters export the selected contacts at their
// studio; every export is recorded first, and an unrecorded one never ships.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

vi.mock('@/lib/auth', async (orig) => ({ ...(await orig()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
const logAuditEvent = vi.fn()
vi.mock('@/lib/audit', () => ({ logAuditEvent: (...a) => logAuditEvent(...a) }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn() }))
const linked = vi.fn()
vi.mock('@/lib/contact-studio-link', () => ({ contactIdsLinkedToStudio: (...a) => linked(...a) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const L = 'a0000000-0000-0000-0000-000000000001'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const userAs = (role) => ({
  id: 'u1', full_name: 'Owner', email: 'o@x.ie', role, profileRole: role,
  activeLocation: { id: L, features: {} }, activeAssignment: { role, permissions: { contacts: true } },
  rolesByLocation: { [L]: role }, assignmentsByLocation: { [L]: { role, permissions: { contacts: true } } },
  locations: [{ id: L, role, features: {} }],
})
const db = () => createFakeDb({ tables: { contacts: [
  { id: id(1), location_id: L, first_name: 'Ann', last_name: 'Byrne', email: 'ann@x.ie', phone: '087', tags: ['vip'], pipeline_stage_slug: 'member', created_at: '2026-11-01T10:00:00Z' },
  { id: id(2), location_id: L, first_name: '=cmd', last_name: 'X', email: 'b@x.ie', created_at: '2026-11-02T10:00:00Z' },
] } })
const post = (ids) => POST(new Request('http://localhost/api/contacts/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_ids: ids }) }), {})

beforeEach(() => {
  vi.clearAllMocks()
  logAuditEvent.mockResolvedValue({ logged: true })
  linked.mockImplementation(async (_db, { contactIds }) => ({ ok: true, ids: contactIds.filter((x) => x !== id(9)), joined: [] }))
})

describe('POST /api/contacts/export', () => {
  it('an owner gets a CSV of the studio\'s selected contacts, recorded first', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    createServerClient.mockReturnValue(db())
    const res = await post([id(1), id(2), id(9)])
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    const text = await res.text()
    expect(text).toContain('Ann,Byrne,ann@x.ie,087,vip,member,2026-11-01')
    expect(text).not.toMatch(/(^|\n)=cmd/) // the CSV-injection guard
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business', action: 'contacts_exported', locationId: L,
      details: { exported: 2, requested: 3, skipped: 1 },
    }))
  })

  it('a manager is refused, and nothing is read or recorded', async () => {
    getCurrentUser.mockResolvedValue(userAs('manager'))
    createServerClient.mockReturnValue(db())
    const res = await post([id(1)])
    expect(res.status).toBe(403)
    expect(linked).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('an export that cannot be recorded is not handed over', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    createServerClient.mockReturnValue(db())
    logAuditEvent.mockResolvedValue({ logged: false, error: 'down' })
    const res = await post([id(1)])
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('ann@x.ie')
  })

  it('an unreadable studio list exports nothing', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    createServerClient.mockReturnValue(db())
    linked.mockResolvedValue({ ok: false, reason: 'location_unreadable' })
    expect((await post([id(1)])).status).toBe(503)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
