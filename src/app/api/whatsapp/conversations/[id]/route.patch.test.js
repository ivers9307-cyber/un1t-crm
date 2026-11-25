// INBOXFOLLOW.1 — PATCH /api/whatsapp/conversations/[id]: resolving completes
// every follow-up column; reopening changes none of them.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const CONV_A = '1c000000-0000-4000-8000-00000000000a'
const INBOX_A = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const patch = (body) => PATCH(new Request(`http://localhost/api/whatsapp/conversations/${CONV_A}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: CONV_A }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    whatsapp_conversations: [{
      id: CONV_A, location_id: LOC_A, resolved_at: null, agent_handed_off_at: null,
      customer_waiting_since: 'x', staff_owned_since: 'x', staff_waiting_since: 'x', staff_nudged_at: 'x',
      staff_nudge_outcome: 'sent', handoff_requested_at: 'x', snoozed_until: 'x', snoozed_by: 'u', snooze_note: 'n',
    }],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(INBOX_A)
})

describe('PATCH /api/whatsapp/conversations/[id] — follow-up state', () => {
  it('resolved:false leaves the follow-up columns alone', async () => {
    expect((await patch({ resolved: false })).status).toBe(200)
    expect(db.tables.whatsapp_conversations[0]).toMatchObject({
      resolved_at: null, staff_owned_since: 'x', snoozed_until: 'x', handoff_requested_at: 'x', customer_waiting_since: 'x',
    })
  })

  it('resolved:true nulls all nine follow-up columns', async () => {
    expect((await patch({ resolved: true })).status).toBe(200)
    const row = db.tables.whatsapp_conversations[0]
    expect(row.resolved_at).not.toBeNull()
    expect(row).toMatchObject({
      customer_waiting_since: null, staff_owned_since: null, staff_waiting_since: null, staff_nudged_at: null,
      staff_nudge_outcome: null, handoff_requested_at: null, snoozed_until: null, snoozed_by: null, snooze_note: null,
    })
  })
})
