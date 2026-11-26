// POST /api/instagram/conversations/[id]/add-contact through the real withAuth
// wrapper, which only signs the caller in. The channel permission (403), the
// body, the conversation (404) and its studio (404, never 403) keep their order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/instagram-contact-link-server', async (importOriginal) => ({ ...(await importOriginal()), linkThreadToContact: vi.fn(async () => true) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { linkThreadToContact } = await import('@/lib/instagram-contact-link-server')
const { POST } = await import('./route.js')

const CONV_A = '1c100000-0000-4000-8000-00000000000a'
const CONV_B = '1c100000-0000-4000-8000-00000000000b'
const INBOX_A = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const NO_INBOX = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A)
const add = (id, body = { name: 'Sam Sender' }) => POST(new Request(`http://localhost/api/instagram/conversations/${id}/add-contact`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    instagram_conversations: [
      { id: CONV_A, location_id: LOC_A, contact_id: null, ig_user_id: 'igsid-a', ig_username: 'sam', customer_name: null },
      { id: CONV_B, location_id: LOC_B, contact_id: null, ig_user_id: 'igsid-b', ig_username: 'kim', customer_name: null },
    ],
    contacts: [],
    activities: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/instagram/conversations/[id]/add-contact', () => {
  it('401 signed out, nothing created', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await add(CONV_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.contacts).toEqual([])
  })

  it('403 without the inbox permission, nothing created', async () => {
    getCurrentUser.mockResolvedValue(NO_INBOX)
    expect((await add(CONV_A)).status).toBe(403)
    expect(db.tables.contacts).toEqual([])
  })

  it('404 for another studio’s conversation, nothing created', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    expect((await add(CONV_B)).status).toBe(404)
    expect(db.tables.contacts).toEqual([])
  })

  it('creates the contact at the conversation’s studio and links the thread', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    const res = await add(CONV_A)
    expect(res.status).toBe(200)
    expect(db.tables.contacts[0]).toMatchObject({ location_id: LOC_A, name: 'Sam Sender', instagram_igsid: 'igsid-a' })
    expect(linkThreadToContact).toHaveBeenCalledTimes(1)
  })

  it('a failed create answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    db.errors.contacts = { insert: { message: 'duplicate key value violates unique constraint "contacts_email_org_key"' } }
    const res = await add(CONV_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not create the contact. Try again.' })
    expect(linkThreadToContact).not.toHaveBeenCalled()
  })
})

describe('SECGAPS.1 — the inbox key is judged at the conversation\'s studio', () => {
  it('403 at a member studio without the key, nothing created', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A))
    expect((await add(CONV_B)).status).toBe(403)
    expect(db.tables.contacts).toEqual([])
  })

  it('creates at the thread\'s studio when the key is held there but not at the active studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A))
    expect((await add(CONV_B)).status).toBe(200)
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0].location_id).toBe(LOC_B)
  })
})

describe('INBOXPERM.1 — web-only: the phone key alone is refused', () => {
  it('403 for a caller holding only the phone key, nothing created', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false, mobile: { whatsapp: true } } } }, LOC_A))
    expect((await add(CONV_A)).status).toBe(403)
    expect(db.tables.contacts).toEqual([])
  })
})
