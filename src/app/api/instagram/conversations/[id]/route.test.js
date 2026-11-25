// /api/instagram/conversations/[id] through the real withAuth wrapper, which
// only signs the caller in. The channel permission (403), the row (404) and
// its studio (404, never 403) keep their order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PATCH } = await import('./route.js')

const CONV_A = '1c000000-0000-4000-8000-00000000000a'
const CONV_B = '1c000000-0000-4000-8000-00000000000b'
const INBOX_A = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const NO_INBOX = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A)
const ctx = (id) => ({ params: Promise.resolve({ id }) })
const get = (id) => GET(new Request(`http://localhost/api/instagram/conversations/${id}`), ctx(id))
const patch = (id, body = { resolved: true }) => PATCH(new Request(`http://localhost/api/instagram/conversations/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), ctx(id))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    instagram_conversations: [
      { id: CONV_A, location_id: LOC_A, unread_count: 3, resolved_at: null, agent_handed_off_at: null },
      { id: CONV_B, location_id: LOC_B, unread_count: 2, resolved_at: null, agent_handed_off_at: null },
    ],
    instagram_messages: [],
    contacts: [],
    profiles: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/instagram/conversations/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(CONV_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without the inbox permission', async () => {
    getCurrentUser.mockResolvedValue(NO_INBOX)
    expect((await get(CONV_A)).status).toBe(403)
  })

  it('404 for another studio’s thread, unread left alone', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    expect((await get(CONV_B)).status).toBe(404)
    expect(db.tables.instagram_conversations[1].unread_count).toBe(2)
  })

  it('opens the caller’s own thread and clears unread', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    const res = await get(CONV_A)
    expect(res.status).toBe(200)
    expect(db.tables.instagram_conversations[0].unread_count).toBe(0)
  })

  it('INBOXFOLLOW.2 — handled_by_name is the assignee\'s first name when a person has the thread, else null', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    db.tables.profiles = [{ id: '5c000000-0000-4000-8000-000000000001', full_name: 'Anna Murphy', email: 'a@x.test', role: 'staff' }]
    db.tables.instagram_conversations[0].agent_active = false
    db.tables.instagram_conversations[0].assigned_to = '5c000000-0000-4000-8000-000000000001'
    const body = await (await get(CONV_A)).json()
    expect(body.conversation.handled_by_name).toBe('Anna')
    expect(body.conversation).not.toHaveProperty('profiles')

    db.tables.instagram_conversations[0].agent_active = true
    expect((await (await get(CONV_A)).json()).conversation.handled_by_name).toBeNull()
  })

  it('INBOXFOLLOW.2 — a failed name read still opens the thread, with a null name', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    db.tables.instagram_conversations[0].agent_active = false
    db.tables.instagram_conversations[0].assigned_to = '5c000000-0000-4000-8000-000000000001'
    db.errors.profiles = { select: { message: 'boom' } }
    const res = await get(CONV_A)
    expect(res.status).toBe(200)
    expect((await res.json()).conversation.handled_by_name).toBeNull()
  })
})

describe('PATCH /api/instagram/conversations/[id]', () => {
  it('401 signed out, 404 for another studio’s thread, nothing resolved', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch(CONV_A)).status).toBe(401)
    getCurrentUser.mockResolvedValue(INBOX_A)
    expect((await patch(CONV_B)).status).toBe(404)
    expect(db.tables.instagram_conversations[1].resolved_at).toBeNull()
  })

  it('resolves the caller’s own thread', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    expect((await patch(CONV_A)).status).toBe(200)
    expect(db.tables.instagram_conversations[0].resolved_at).not.toBeNull()
  })

  // INBOXFOLLOW.1 — resolve completes the follow-up state; reopen changes none of it.
  it('resolve:true nulls the nine follow-up columns; resolve:false leaves them alone', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    Object.assign(db.tables.instagram_conversations[0], {
      customer_waiting_since: 'x', staff_owned_since: 'x', staff_waiting_since: 'x', staff_nudged_at: 'x',
      staff_nudge_outcome: 'sent', handoff_requested_at: 'x', snoozed_until: 'x', snoozed_by: 'u', snooze_note: 'n',
    })
    expect((await patch(CONV_A, { resolved: false })).status).toBe(200)
    expect(db.tables.instagram_conversations[0]).toMatchObject({ staff_owned_since: 'x', snoozed_until: 'x', handoff_requested_at: 'x' })
    expect((await patch(CONV_A, { resolved: true })).status).toBe(200)
    expect(db.tables.instagram_conversations[0]).toMatchObject({
      customer_waiting_since: null, staff_owned_since: null, staff_waiting_since: null, staff_nudged_at: null,
      staff_nudge_outcome: null, handoff_requested_at: null, snoozed_until: null, snoozed_by: null, snooze_note: null,
    })
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(INBOX_A)
    db.errors.instagram_conversations = { update: { message: 'column "resolved_at" is of type timestamptz' } }
    const res = await patch(CONV_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not update the conversation. Try again.' })
  })
})

describe('SECGAPS.1 — the inbox key is judged at the conversation\'s studio', () => {
  const keyAtAOnly = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A)
  const keyAtBOnly = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)

  it('403 at a member studio where the caller lacks the key, even with it at the active studio', async () => {
    getCurrentUser.mockResolvedValue(keyAtAOnly)
    expect((await get(CONV_B)).status).toBe(403)
    expect((await patch(CONV_B)).status).toBe(403)
    expect(db.tables.instagram_conversations[1].unread_count).toBe(2)
    expect(db.tables.instagram_conversations[1].resolved_at).toBeNull()
  })

  it('passes at the thread\'s studio when the key is held there but not at the active studio', async () => {
    getCurrentUser.mockResolvedValue(keyAtBOnly)
    expect((await get(CONV_B)).status).toBe(200)
    expect((await patch(CONV_B)).status).toBe(200)
    expect((await get(CONV_A)).status).toBe(403)
  })
})
