// /api/accounting/mailboxes through the real withAuth wrapper, which only signs
// the caller in. accounting_hub at the active studio (403 'Forbidden'), the
// active studio (400), the body and the live IMAP check keep their order; the
// password column is never read back.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/recon/imap-client', async (importOriginal) => ({ ...(await importOriginal()), verifyMailboxLogin: vi.fn(async () => ({ ok: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { verifyMailboxLogin } = await import('@/lib/recon/imap-client')
const { GET, POST } = await import('./route.js')

const HUB_A = person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: true } } }, LOC_A)
const NO_HUB = person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: false } } }, LOC_A)
const BODY = { label: 'Bills', email: 'bills@example.com', password: 'app-password-1' }
const post = (body = BODY) => POST(new Request('http://localhost/api/accounting/mailboxes', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { recon_mailboxes: [
    { id: 'aa000000-0000-4000-8000-00000000000a', location_id: LOC_A, label: 'A', email: 'a@example.com', imap_password: 'secret-a', active: true, created_at: '2026-11-01T00:00:00Z' },
    { id: 'aa000000-0000-4000-8000-00000000000b', location_id: LOC_B, label: 'B', email: 'b@example.com', imap_password: 'secret-b', active: true, created_at: '2026-11-01T00:00:00Z' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/accounting/mailboxes', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/accounting/mailboxes'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without accounting_hub', async () => {
    getCurrentUser.mockResolvedValue(NO_HUB)
    const res = await GET(new Request('http://localhost/api/accounting/mailboxes'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('lists only the active studio’s inboxes, never the password', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    const res = await GET(new Request('http://localhost/api/accounting/mailboxes'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((m) => m.label)).toEqual(['A'])
    expect(JSON.stringify(body)).not.toContain('secret-')
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    db.errors.recon_mailboxes = { select: { message: 'relation "recon_mailboxes" does not exist' } }
    const res = await GET(new Request('http://localhost/api/accounting/mailboxes'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the inboxes. Try again.' })
  })
})

describe('POST /api/accounting/mailboxes', () => {
  it('401 signed out, IMAP never tried', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(verifyMailboxLogin).not.toHaveBeenCalled()
  })

  it('403 without accounting_hub, IMAP never tried', async () => {
    getCurrentUser.mockResolvedValue(NO_HUB)
    expect((await post()).status).toBe(403)
    expect(verifyMailboxLogin).not.toHaveBeenCalled()
  })

  it('adds the inbox at the active studio', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.tables.recon_mailboxes.at(-1)).toMatchObject({ location_id: LOC_A, email: 'bills@example.com', created_by: HUB_A.id })
  })

  it('a failed insert answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    db.errors.recon_mailboxes = { insert: { code: 'XX000', message: 'insert or update on table violates foreign key' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not add the inbox. Try again.' })
  })
})
