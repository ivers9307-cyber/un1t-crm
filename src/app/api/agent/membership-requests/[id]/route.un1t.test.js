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
import { sendAgentThreadMessage } from '@/lib/agent/notify'
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

// FLOWACK.1 review — a un1t.online card filed from a WhatsApp Flow carries its
// thread (routeToReview links it): approving it confirms there too, like the
// Glofox approve path (the email still goes). A record-only approval records
// what staff did by hand and confirms nothing.
describe('approval route — un1t.online Flow cards confirm on the thread', () => {
  const flow = (reason, over = {}) => ({ ...ROW(reason, over), channel: 'whatsapp', conversation_id: 'conv1' })

  it('actioned with a thread: the in-thread confirmation goes', async () => {
    db = makeDbFor(flow('un1t_outcome_unknown'))
    await approve()
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(sendAgentThreadMessage.mock.calls[0][1]).toMatchObject({ channel: 'whatsapp', conversationId: 'conv1', text: 'Booked!' })
  })

  it('a record-only approval or a failed execution confirms nothing', async () => {
    db = makeDbFor(flow('account_ambiguous'))
    executeUn1tApproval.mockResolvedValueOnce({ finalStatus: 'actioned', details: {}, executed: { ok: true, record_only: true }, customerNotified: null })
    await approve()
    updates = []
    db = makeDbFor(flow('un1t_outcome_unknown'))
    executeUn1tApproval.mockResolvedValueOnce({ finalStatus: 'failed', details: {}, executed: { ok: false }, customerNotified: null })
    await approve()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('no thread (a website card): email only, as before', async () => {
    db = makeDbFor(ROW('un1t_outcome_unknown'))
    await approve()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })
})

// MIAHATCH.5 Task 18 — Mia's Hatch Street cards (details.origin 'mia') run
// D's executor through executeMiaUn1tCard: the account guard first, then one
// in-thread confirmation. A un1t.online class_cancellation never reaches the
// Glofox cancel, whatever its origin.
describe("approval route — Mia's Hatch cards", () => {
  const MIA = (kind, over = {}) => ({
    id: 'r1', location_id: 'L1', kind, status: 'pending', contact_id: 'c1', channel: 'whatsapp', conversation_id: 'conv1',
    details: {
      provider: 'un1t_online', origin: 'mia', un1t_user_id: 'u-1', executing_contact_id: 'c1', starts_at: future,
      class_name: 'RALLY', class_time: 'Tue 20 Oct, 7:00am',
      ...(kind === 'class_booking' ? { reason: 'mia_booking', event_id: 'ev-1' } : { reason: 'mia_cancellation', booking_id: 'bk-1' }),
      ...over,
    },
  })
  function makeMiaDb(row, { contactUser = 'u-1', clients = ['u-1'] } = {}) {
    return {
      from(table) {
        let patch = null
        const b = {
          select: () => b, eq: () => b, neq: () => b, contains: () => b, insert: () => b, is: () => b, limit: () => b, in: () => b, ilike: () => b, not: () => b,
          then(resolve, reject) {
            const data = table === 'un1t_clients' ? clients.map((id) => ({ un1t_user_id: id })) : []
            return Promise.resolve({ data, error: null }).then(resolve, reject)
          },
          update(p) { patch = p; updates.push({ table, patch: p }); return b },
          async maybeSingle() {
            if (patch) return { data: { id: row.id }, error: null }
            if (table === 'agent_membership_requests') return { data: row, error: null }
            if (table === 'locations') return { data: { id: 'L1', name: 'Hatch', organization_id: 'O1', membership_source: 'un1t_online', settings: {} }, error: null }
            if (table === 'contacts') return { data: { id: 'c1', email: 'member@example.test', un1t_user_id: contactUser }, error: null }
            return { data: null, error: null }
          },
          async single() { return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null } },
        }
        return b
      },
    }
  }

  it("Mia un1t card goes to executeUn1tApproval, never the Glofox executor; confirmed in-thread once", async () => {
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: true })
    db = makeMiaDb(MIA('class_booking'))
    const j = await (await approve()).json()
    expect(executeUn1tApproval).toHaveBeenCalledOnce()
    expect(executeUn1tApproval.mock.calls[0][1].actor).toEqual({ id: 'staff-1' })
    expect(glofox.createBooking).not.toHaveBeenCalled()
    expect(sendManualBookingConfirmEmail).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(sendAgentThreadMessage.mock.calls[0][1]).toMatchObject({ channel: 'whatsapp', conversationId: 'conv1', text: 'Booked!' })
    expect(finalRow().status).toBe('actioned')
    expect(finalRow().details.confirmation).toEqual({ sent: true })
    expect(j.customer_notified).toEqual({ sent: true, channel: 'whatsapp' })
  })

  it("a Mia un1t class_cancellation runs D's executor, never the Glofox cancel, and confirms the cancellation", async () => {
    db = makeMiaDb(MIA('class_cancellation'))
    await approve()
    expect(executeUn1tApproval).toHaveBeenCalledOnce()
    expect(executeUn1tApproval.mock.calls[0][1].row.kind).toBe('class_cancellation')
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
    expect(glofox.glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('Cancelled.')
    expect(finalRow().status).toBe('actioned')
  })

  it('a un1t.online class_cancellation not filed by Mia never reaches Glofox: failed with a staff code', async () => {
    const row = MIA('class_cancellation')
    delete row.details.origin
    db = makeMiaDb(row)
    const j = await (await approve()).json()
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
    expect(glofox.glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(executeUn1tApproval).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(j.executed).toEqual({ ok: false, message_code: 'NOT_EXECUTABLE_UN1T' })
    expect(finalRow().status).toBe('failed')
  })

  it('ACCOUNT_MISMATCH refuses and lands failed (Fix & retry lane), nothing called', async () => {
    db = makeMiaDb(MIA('class_booking'), { contactUser: 'u-2', clients: ['u-2'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const j = await (await approve()).json()
    warn.mockRestore()
    expect(executeUn1tApproval).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(j.executed).toMatchObject({ ok: false, message_code: 'ACCOUNT_MISMATCH' })
    expect(finalRow().status).toBe('failed')
    expect(finalRow().details.result.message_code).toBe('ACCOUNT_MISMATCH')
  })

  it('past start -> expired, no call, no message (booking and cancellation)', async () => {
    for (const kind of ['class_booking', 'class_cancellation']) {
      vi.clearAllMocks()
      updates = []
      db = makeMiaDb(MIA(kind, { starts_at: past }))
      const j = await (await approve()).json()
      expect(j.executed).toEqual({ ok: false, reason: 'CLASS_ALREADY_STARTED' })
      expect(executeUn1tApproval).not.toHaveBeenCalled()
      expect(glofox.cancelBooking).not.toHaveBeenCalled()
      expect(sendAgentThreadMessage).not.toHaveBeenCalled()
      expect(finalRow().status).toBe('expired')
    }
  })

  it('window_closed is recorded on the card; the card stays actioned', async () => {
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    db = makeMiaDb(MIA('class_booking'))
    const j = await (await approve()).json()
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(finalRow().status).toBe('actioned')
    expect(finalRow().details.confirmation).toEqual({ sent: false, reason: 'window_closed' })
    expect(j.customer_notified).toEqual({ sent: false, channel: 'whatsapp', reason: 'window_closed' })
  })

  it("a /start funnel card keeps D's path: executeUn1tApproval called as before (no executor overrides)", async () => {
    db = makeDbFor(ROW('un1t_outcome_unknown'))
    await approve()
    expect(executeUn1tApproval.mock.calls[0]).toHaveLength(2)
  })
})
