// AUDITEXPORT.1 (October audit A20) — a single-contact export is recorded with
// a category audit_events accepts, BEFORE the file leaves; no record, no file.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'

vi.mock('@/lib/auth', async (orig) => ({ ...(await orig()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
const logAuditEvent = vi.fn()
vi.mock('@/lib/audit', () => ({ logAuditEvent: (...a) => logAuditEvent(...a) }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn() }))
const buildContactExport = vi.fn()
vi.mock('@/lib/contact-export', () => ({ buildContactExport: (...a) => buildContactExport(...a) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const L = 'a0000000-0000-0000-0000-000000000001'
const C = '00000000-0000-4000-8000-000000000001'
const userAs = (role) => ({
  id: 'u1', full_name: 'Owner', email: 'o@x.ie', role, profileRole: role,
  activeLocation: { id: L, features: {} }, activeAssignment: { role, permissions: {} },
  rolesByLocation: { [L]: role }, assignmentsByLocation: { [L]: { role, permissions: {} } },
  locations: [{ id: L, role, features: {} }],
})
const get = () => GET(new Request(`http://localhost/api/contacts/${C}/export`), { params: Promise.resolve({ id: C }) })

beforeEach(() => {
  vi.clearAllMocks()
  logAuditEvent.mockResolvedValue({ logged: true })
  buildContactExport.mockResolvedValue({ contact: { id: C } })
  createServerClient.mockReturnValue(createFakeDb({ tables: { contacts: [{ id: C, name: 'Ann Byrne', email: 'ann@x.ie', location_id: L }] } }))
})

describe('GET /api/contacts/[id]/export', () => {
  it('records the export under a category the audit table accepts, then sends the file', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/contact-export-/)
    const [event] = logAuditEvent.mock.calls[0]
    expect(event).toMatchObject({ category: 'business', action: 'contact_export', locationId: L })
    // audit_events_category_check (mig 180)
    expect(['auth', 'business', 'mutation', 'assignment']).toContain(event.category)
  })

  it('an export the audit log did not take is withheld (503), never sent unrecorded', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    logAuditEvent.mockResolvedValue({ logged: false, error: 'violates check constraint' })
    const res = await get()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(JSON.stringify(body)).not.toContain('check constraint')
  })

  it('a failed bundle answers 500 without the error text, and records nothing', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    buildContactExport.mockRejectedValue(new Error('relation secret_q does not exist'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_q')
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('staff are refused and nothing is recorded', async () => {
    getCurrentUser.mockResolvedValue(userAs('staff'))
    expect((await get()).status).toBe(403)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
