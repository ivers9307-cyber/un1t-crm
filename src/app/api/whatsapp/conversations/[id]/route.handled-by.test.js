// INBOXFOLLOW.2 — GET /api/whatsapp/conversations/[id] answers handled_by_name:
// the assignee's first name, else the first name of the newest staff sender,
// else null; a failed name read never fails the thread load.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CONV = '1c000000-0000-4000-8000-00000000000a'
const ANNA = '5c000000-0000-4000-8000-000000000001'
const BEN = '5c000000-0000-4000-8000-000000000002'
const caller = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const get = () => GET(new Request(`http://localhost/api/whatsapp/conversations/${CONV}`), { params: Promise.resolve({ id: CONV }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(caller)
  db = createFakeDb({ tables: {
    whatsapp_conversations: [{ id: CONV, location_id: LOC_A, unread_count: 0, agent_active: false, staff_owned_since: '2026-11-25T10:00:00Z', assigned_to: null }],
    whatsapp_messages: [
      { id: '2c000000-0000-4000-8000-000000000001', conversation_id: CONV, direction: 'outbound', sent_by: BEN, created_at: '2026-11-25T10:00:00Z' },
    ],
    profiles: [
      { id: ANNA, full_name: 'Anna Murphy', email: 'a@x.test', role: 'staff' },
      { id: BEN, full_name: 'Ben Carter', email: 'b@x.test', role: 'staff' },
    ],
    contacts: [],
    locations: [{ id: LOC_A, settings: {} }],
    location_whatsapp_numbers: [],
    whatsapp_numbers: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/whatsapp/conversations/[id] — handled_by_name', () => {
  it('names the assignee first', async () => {
    db.tables.whatsapp_conversations[0].assigned_to = ANNA
    expect((await (await get()).json()).conversation.handled_by_name).toBe('Anna')
  })

  it('else the sender of the newest staff message', async () => {
    expect((await (await get()).json()).conversation.handled_by_name).toBe('Ben')
  })

  it('null when Mia has the thread, with no profile read', async () => {
    Object.assign(db.tables.whatsapp_conversations[0], { agent_active: true, staff_owned_since: null })
    const body = await (await get()).json()
    expect(body.conversation.handled_by_name).toBeNull()
    expect(db.calls.map((c) => c.table)).not.toContain('profiles')
  })

  it('a failed profile read still loads the thread, with a null name', async () => {
    db.errors.profiles = { select: { message: 'boom' } }
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.conversation.handled_by_name).toBeNull()
  })
})
