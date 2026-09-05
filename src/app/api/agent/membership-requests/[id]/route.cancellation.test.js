// CANCEL-FORM.5 — approving a membership cancellation: executes in Glofox
// only when the location opted in, confirms the member on the channel the
// request arrived by, and lets staff supply the end date on the card.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
}))
vi.mock('@/lib/agent/execute-membership-cancellation', () => ({ executeMembershipCancellation: vi.fn() }))
vi.mock('@/lib/cancellation-form/confirm', () => ({ sendMembershipOutcomeMessage: vi.fn(async () => ({ sent: true, channel: 'email' })) }))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  buildDeclineNoticeText: vi.fn(() => 'Declined.'),
  agentConfirmationTemplates: vi.fn(async () => ({ decline: 'Custom decline' })),
}))

import { PATCH } from './route.js'
import { executeMembershipCancellation } from '@/lib/agent/execute-membership-cancellation'
import { sendMembershipOutcomeMessage } from '@/lib/cancellation-form/confirm'
import { sendAgentThreadMessage } from '@/lib/agent/notify'

const ROW = {
  id: 'r1', location_id: 'L1', kind: 'cancellation', status: 'pending', contact_id: 'c1',
  channel: 'email', conversation_id: null,
  details: { source: 'cancellation_form', reason_code: 'price', reason: 'Too dear', requested_end_date: '2026-10-05' },
}
const CONTACT = { id: 'c1', first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@example.com', email_status: 'active', glofox_member_id: '6a0219cee62c0c6c980bc95f', glofox_user_membership_id: null, glofox_membership_plan: 'Unlimited' }

let updates
function makeDb(row, { autoCancel = false } = {}) {
  updates = []
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() {
          if (patch) return { data: { id: row.id }, error: null }
          if (table === 'contacts') return { data: CONTACT, error: null }
          if (table === 'locations') return { data: { name: 'UN1T Stillorgan', glofox_auto_cancel_memberships: autoCancel, settings: { customer_agent: { cancellation_form: {} } } }, error: null }
          return { data: row, error: null }
        },
        async single() {
          return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null }
        },
      }
      return b
    },
  }
}

const patch = (body) => PATCH(
  new Request('http://localhost/api/agent/membership-requests/r1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: 'r1' }) },
)
const finalUpdate = () => updates.filter((u) => u.table === 'agent_membership_requests').at(-1).patch

beforeEach(() => { vi.clearAllMocks() })

describe('toggle OFF (default)', () => {
  it('approves without touching Glofox and emails the confirmation with the requested date', async () => {
    db = makeDb(ROW)
    const res = await patch({ status: 'approved' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.request.status).toBe('approved')
    expect(executeMembershipCancellation).not.toHaveBeenCalled()
    expect(sendMembershipOutcomeMessage).toHaveBeenCalledTimes(1)
    expect(sendMembershipOutcomeMessage.mock.calls[0][1]).toMatchObject({ finalStatus: 'approved', endDate: '2026-10-05', row: expect.objectContaining({ id: 'r1' }), contact: expect.objectContaining({ email: 'a@example.com' }) })
    expect(body.customer_notified).toEqual({ sent: true, channel: 'email' })
    expect(body.planned_end_date).toBe('2026-10-05')
    // No execution marker is stamped when nothing executes.
    expect(updates[0].patch.details).toBeUndefined()
  })

  it('saved sends the saved confirmation; declined on an email row sends the decline by email', async () => {
    db = makeDb(ROW)
    await patch({ status: 'saved' })
    expect(sendMembershipOutcomeMessage.mock.calls[0][1].finalStatus).toBe('saved')
    db = makeDb(ROW)
    await patch({ status: 'declined' })
    expect(sendMembershipOutcomeMessage.mock.calls[1][1]).toMatchObject({ finalStatus: 'declined', declineTemplate: 'Custom decline' })
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('a staff-supplied end_date overrides the requested date on the row and in the confirmation', async () => {
    db = makeDb(ROW)
    await patch({ status: 'approved', end_date: '2026-10-31' })
    expect(finalUpdate().details.requested_end_date).toBe('2026-10-31')
    expect(sendMembershipOutcomeMessage.mock.calls[0][1].endDate).toBe('2026-10-31')
  })

  it('rejects a malformed end_date', async () => {
    db = makeDb(ROW)
    expect((await patch({ status: 'approved', end_date: '31/10/2026' })).status).toBe(400)
  })

  it('a Mia thread row keeps its in-thread decline (no double message)', async () => {
    db = makeDb({ ...ROW, channel: 'whatsapp', conversation_id: 'conv1', details: { reason: 'moving' } })
    await patch({ status: 'declined' })
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    expect(sendMembershipOutcomeMessage).not.toHaveBeenCalled()
  })

  it('a pause row confirms on approve too', async () => {
    db = makeDb({ ...ROW, kind: 'pause', details: { start_date: '2026-09-10', end_date: '2026-10-01', source: 'cancellation_form' } })
    const res = await patch({ status: 'approved' })
    expect((await res.json()).request.status).toBe('approved')
    expect(executeMembershipCancellation).not.toHaveBeenCalled()
    expect(sendMembershipOutcomeMessage.mock.calls[0][1].finalStatus).toBe('approved')
  })
})

describe('toggle ON', () => {
  it('executes the Glofox cancel, lands actioned with the planned end date, and confirms with it', async () => {
    db = makeDb(ROW, { autoCancel: true })
    executeMembershipCancellation.mockResolvedValue({ ok: true, status: 200, message_code: null, local_planned_end_date: '2026-10-06', user_membership_id: 'um' })
    const res = await patch({ status: 'approved' })
    const body = await res.json()
    expect(body.request.status).toBe('actioned')
    expect(executeMembershipCancellation).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'r1' }), expect.objectContaining({ contact: expect.objectContaining({ id: 'c1' }), creds: expect.objectContaining({ apiKey: 'k' }) }))
    // The claim stamped the executing marker; the final write closes it.
    expect(updates[0].patch.details.execution.stage).toBe('executing')
    expect(finalUpdate().details.execution.stage).toBe('done')
    expect(finalUpdate().details.result).toMatchObject({ ok: true, local_planned_end_date: '2026-10-06' })
    expect(sendMembershipOutcomeMessage.mock.calls[0][1]).toMatchObject({ finalStatus: 'actioned', endDate: '2026-10-06' })
    expect(body.planned_end_date).toBe('2026-10-06')
  })

  it('a Glofox rejection lands failed with the code and sends no confirmation', async () => {
    db = makeDb(ROW, { autoCancel: true })
    executeMembershipCancellation.mockResolvedValue({ ok: false, status: 400, message_code: 'MEMBERSHIP_MINIMUM_TERM_NOT_REACHED', local_planned_end_date: null })
    const res = await patch({ status: 'approved' })
    const body = await res.json()
    expect(body.request.status).toBe('failed')
    expect(finalUpdate().details.result.message_code).toBe('MEMBERSHIP_MINIMUM_TERM_NOT_REACHED')
    expect(sendMembershipOutcomeMessage).not.toHaveBeenCalled()
    expect(body.customer_notified).toMatchObject({ sent: false })
  })

  it('a failed cancellation may be re-approved (retry lane)', async () => {
    db = makeDb({ ...ROW, status: 'failed', details: { ...ROW.details, result: { ok: false, message_code: 'NO_USER_MEMBERSHIP' } } }, { autoCancel: true })
    executeMembershipCancellation.mockResolvedValue({ ok: true, message_code: null, local_planned_end_date: '2026-10-05' })
    const res = await patch({ status: 'approved' })
    expect(res.status).toBe(200)
    expect((await res.json()).request.status).toBe('actioned')
  })

  it('saved never executes even with the toggle on', async () => {
    db = makeDb(ROW, { autoCancel: true })
    await patch({ status: 'saved' })
    expect(executeMembershipCancellation).not.toHaveBeenCalled()
  })
})
