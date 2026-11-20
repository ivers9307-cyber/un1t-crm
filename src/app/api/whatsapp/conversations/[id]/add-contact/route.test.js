// ROUTEWRAP.R9 — POST /api/whatsapp/conversations/[id]/add-contact on
// withAuth: signed out is withAuth's 401, the WEB `whatsapp` key is judged at
// the THREAD's studio (INBOXWEBONLY3.1), another studio's thread is 404, a
// caller who passes creates the contact at the thread's studio and links the
// thread, and a failed insert answers a fixed line (the database text is
// logged). Ids and the number are synthetic (the 555 range).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const CONV = '00000000-0000-4000-8000-0000000000c1'
const NEW_CONTACT = '00000000-0000-4000-8000-0000000000c2'
const PHONE = '15555550100'
const WEB = { whatsapp: true, mobile: { whatsapp: false } }
const OFF = { whatsapp: false, mobile: { whatsapp: false } }

const caller = (perms) => ({
  id: 'u1', role: 'staff', activeLocation: { id: A, features: {} },
  activeAssignment: { role: 'staff', permissions: perms[A] ?? OFF },
  locations: Object.keys(perms).map((id) => ({ id, role: 'staff', features: {} })),
  assignmentsByLocation: Object.fromEntries(Object.entries(perms).map(([id, p]) => [id, { role: 'staff', permissions: p }])),
  user: { id: 'u1' },
})

let writes
function fakeDb({ conversation, insertError = null }) {
  writes = []
  return {
    from: (table) => {
      let pendingInsert = null
      const b = {
        select: () => b, eq: () => b, is: () => b, order: () => b,
        insert: (row) => { writes.push({ table, op: 'insert', row }); pendingInsert = row; return b },
        update: (row) => { writes.push({ table, op: 'update', row }); return b },
        single: async () => {
          if (table === 'whatsapp_conversations') return { data: conversation, error: conversation ? null : { message: 'no rows' } }
          if (table === 'contacts' && pendingInsert) return insertError ? { data: null, error: insertError } : { data: { id: NEW_CONTACT }, error: null }
          return { data: null, error: null }
        },
        then: (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad),
      }
      return b
    },
  }
}

const CONVERSATION = { id: CONV, contact_id: null, wa_phone: PHONE, wa_profile_name: 'Synthetic Sender', location_id: B }
const post = (body = { name: 'Synthetic Person' }) => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV}/add-contact`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(fakeDb({ conversation: CONVERSATION }))
})

describe('POST /api/whatsapp/conversations/[id]/add-contact', () => {
  it('signed out: withAuth\'s 401, nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no WEB key at the thread\'s studio: 403; another studio\'s thread: 404; nothing written', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: WEB, [B]: OFF }))
    expect((await post()).status).toBe(403)
    getCurrentUser.mockResolvedValue(caller({ [A]: WEB }))
    expect((await post()).status).toBe(404)
    expect(writes).toEqual([])
  })

  it('WEB key at the thread\'s studio: creates the contact there and links the thread', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: OFF, [B]: WEB }))
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, contact_id: NEW_CONTACT, already_linked: false })
    expect(writes[0]).toMatchObject({ table: 'contacts', op: 'insert', row: { location_id: B, wa_phone: PHONE, lead_source: 'whatsapp' } })
    expect(writes).toContainEqual({ table: 'whatsapp_conversations', op: 'update', row: { contact_id: NEW_CONTACT } })
  })

  it('a failed insert: 500 with a fixed line, the database text logged', async () => {
    getCurrentUser.mockResolvedValue(caller({ [B]: WEB }))
    createServerClient.mockReturnValue(fakeDb({ conversation: CONVERSATION, insertError: { message: 'duplicate key value violates unique constraint "contacts_email_key"' } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not create the contact.' })
    expect(logError).toHaveBeenCalledWith('wa-add-contact', 'contact insert failed', expect.objectContaining({ conversationId: CONV }))
  })
})
