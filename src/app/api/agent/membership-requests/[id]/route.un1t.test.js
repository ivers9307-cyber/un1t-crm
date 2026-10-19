// UN1TWRITE.23 — the approval route's un1t.online funnel branch. The executor
// is mocked: this pins the routing, the past-start guard and what the card
// records. Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/glofox', async (o) => ({
  ...(await o()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(), cancelBooking: vi.fn(), purchaseGlofoxMembership: vi.fn(), fetchUserCreditsResult: vi.fn(), glofoxFetch: vi.fn(),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ ok: true })),
  buildDeclineNoticeText: vi.fn(() => 'Sorry.'),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))
vi.mock('@/lib/un1t-online-approval-execute', () => ({ executeUn1tApproval: vi.fn() }))
vi.mock('@/lib/manual-booking-confirm', () => ({ sendManualBookingConfirmEmail: vi.fn(async () => ({ sent: true, channel: 'email' })) }))

import * as glofox from '@/lib/glofox'
import { executeUn1tApproval } from '@/lib/un1t-online-approval-execute'
import { sendManualBookingConfirmEmail } from '@/lib/manual-booking-confirm'
import { PATCH, maxDuration } from './route.js'

const future = new Date(Date.now() + 86_400_000).toISOString()
const past = new Date(Date.now() - 3_600_000).toISOString()
const ROW = (reason, over = {}) => ({
  id: 'r1', location_id: 'L1', kind: 'class_booking', status: 'pending', contact_id: 'c1', channel: null, conversation_id: null,
  details: { provider: 'un1t_online', reason, event_id: 'un1t:ev-1', class_name: 'RALLY', starts_at: future, source: 'start_funnel', executing_contact_id: 'c1', ...over },
})

let updates
function makeDbFor(row) {
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b, eq: () => b, neq: () => b, contains: () => b, insert: () => b, is: () => b, limit: () => b, in: () => b,
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) },
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() { return patch ? { data: { id: row.id }, error: null } : { data: table === 'agent_membership_requests' ? row : null, error: null } },
        async single() { return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null } },
      }
      return b
    },
  }
}
const approve = () => PATCH(new Request('http://localhost/api/agent/membership-requests/r1', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
}), { params: Promise.resolve({ id: 'r1' }) })
const finalRow = () => updates.filter((u) => u.table === 'agent_membership_requests').at(-1).patch

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  executeUn1tApproval.mockResolvedValue({ finalStatus: 'actioned', details: { provider: 'un1t_online', result: { ok: true } }, executed: { ok: true, un1t_booking_id: 'bk-1' }, customerNotified: { sent: true, channel: 'email' } })
})

describe('approval route — un1t.online funnel cards', () => {
  it('has room for a write and its check read', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(120)
  })

  it('a un1t.online class_booking card never reaches the Glofox executor, nor the manual record', async () => {
    db = makeDbFor(ROW('un1t_outcome_unknown'))
    const res = await approve()
    const j = await res.json()
    expect(j.executed).toEqual({ ok: true, un1t_booking_id: 'bk-1' })
    expect(j.customer_notified).toEqual({ sent: true, channel: 'email' })
    expect(executeUn1tApproval).toHaveBeenCalledOnce()
    expect(executeUn1tApproval.mock.calls[0][1].actor).toEqual({ id: 'staff-1' })
    expect(glofox.createBooking).not.toHaveBeenCalled()
    expect(sendManualBookingConfirmEmail).not.toHaveBeenCalled()
    expect(finalRow().status).toBe('actioned')
  })

  it('an executing card whose class has started expires; a record-only one records', async () => {
    db = makeDbFor(ROW('un1t_outcome_unknown', { starts_at: past }))
    let j = await (await approve()).json()
    expect(j.executed).toEqual({ ok: false, reason: 'CLASS_ALREADY_STARTED' })
    expect(executeUn1tApproval).not.toHaveBeenCalled()
    expect(finalRow().status).toBe('expired')
    updates = []
    db = makeDbFor(ROW('account_ambiguous', { starts_at: past }))
    executeUn1tApproval.mockResolvedValueOnce({ finalStatus: 'actioned', details: {}, executed: { ok: true, record_only: true }, customerNotified: null })
    j = await (await approve()).json()
    expect(j.executed).toEqual({ ok: true, record_only: true })
    expect(finalRow().status).toBe('actioned')
  })

  it('a processing_error card stamped un1t_online resumes through the executor (never the Glofox booker)', async () => {
    db = makeDbFor(ROW('processing_error'))
    await approve()
    expect(executeUn1tApproval).toHaveBeenCalledOnce()
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('an executor that cannot read what it needs answers 500 and the card stays as claimed', async () => {
    db = makeDbFor(ROW('un1t_outcome_unknown'))
    executeUn1tApproval.mockRejectedValueOnce(new Error('db down'))
    const res = await approve()
    expect(res.status).toBe(500)
    expect(updates.filter((u) => u.table === 'agent_membership_requests')).toHaveLength(1) // the claim only
  })

  it('a Glofox-era card with a un1t: id and no provider is still recorded as a manual booking', async () => {
    db = makeDbFor({ ...ROW('manual_booking'), details: { reason: 'manual_booking', event_id: 'un1t:ev-1', class_name: 'RALLY', starts_at: future, source: 'start_funnel' } })
    const j = await (await approve()).json()
    expect(j.executed).toEqual({ ok: true, manual: true })
    expect(executeUn1tApproval).not.toHaveBeenCalled()
  })
})
