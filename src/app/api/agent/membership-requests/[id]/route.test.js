// MIA-BOOKCHECK — approving a class_booking executes createBooking, and
// Glofox can return HTTP 200 with a failure body (message_code
// YOU_HAVE_NO_CREDITS_LEFT, live 2026-07-27). The route must judge success
// on the created booking id (interpretBookingResult — REAL here, only the
// HTTP call is mocked), land the row on 'failed', and never send the
// in-thread confirmation for a booking that did not happen.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ ok: true })),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))

import { createBooking } from '@/lib/glofox'
import { sendAgentThreadMessage } from '@/lib/agent/notify'
import { PATCH } from './route.js'

const ROW = {
  id: 'r1',
  location_id: 'L1',
  kind: 'class_booking',
  status: 'pending',
  details: { event_id: '6a44fd4ef7a9ab28b6017da5', class_name: 'ARENA', class_time: 'Mon 06:15' },
  contact_id: 'c1',
  channel: 'whatsapp',
  conversation_id: 'conv1',
}

// Minimal chainable double: read row → atomic claim → contact read →
// final outcome update. Every update patch is recorded for assertions.
function makeDb(updates) {
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b,
        eq: () => b,
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() {
          if (patch) return { data: { id: ROW.id }, error: null } // claim succeeded
          if (table === 'contacts') return { data: { glofox_member_id: 'gm1' }, error: null }
          return { data: ROW, error: null }
        },
        async single() {
          return { data: { id: ROW.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null }
        },
      }
      return b
    },
  }
}

const approve = () => PATCH(
  new Request('http://localhost/api/agent/membership-requests/r1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  }),
  { params: Promise.resolve({ id: 'r1' }) },
)

let updates
beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  db = makeDb(updates)
})

describe('PATCH class_booking approval — Glofox body decides success, not HTTP status', () => {
  it('HTTP 200 with a failure body → row failed, message_code kept, NO confirmation sent', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })

    const res = await approve()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.executed).toMatchObject({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT', glofox_booking_id: null })
    const final = updates.at(-1).patch
    expect(final.status).toBe('failed')
    expect(final.details.result).toMatchObject({ ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' })
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('real success (body carries the booking id) → actioned, id stored, confirmation sent', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-9' } })

    const res = await approve()
    const json = await res.json()

    expect(json.executed).toMatchObject({ ok: true, glofox_booking_id: 'gfb-9' })
    const final = updates.at(-1).patch
    expect(final.status).toBe('actioned')
    expect(final.details.result).toMatchObject({ glofox_booking_id: 'gfb-9' })
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
  })

  it('HTTP 200 with an idless body → failed (no phantom actioned rows)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: {} })

    await approve()

    expect(updates.at(-1).patch.status).toBe('failed')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })
})
