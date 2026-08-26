// MIA-CREDITS.1 — book_class pre-flights the balance before drafting or
// executing. Confirmed-empty (no credits, no active membership) files a
// pending approval and returns no_credits so the auto-reply loop hands the
// thread to a human; a positive balance, an active membership, or an
// UNREADABLE balance all proceed (a broken pre-check must never block a
// booking that would have worked).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  GLOFOX_BOOKING_MODEL: 'events',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUserCreditsResult: vi.fn(),
  createBooking: vi.fn(async () => ({ ok: true, status: 200, body: { _id: 'gfb-1' } })),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import * as glofox from '@/lib/glofox'
import { notifyAgentApprovalRequest } from './approval-notify'
import { executeBookingTool } from './booking-tools'

const EVENT_ID = '64aa00000000000000000001'

function stubDb(trace, { membershipStatus = null, membershipState = null, pendingRows = [] } = {}) {
  const db = {
    from(table) {
      let selected = false
      const b = {
        // Traced (not just resolved regardless of what was asked for) so a
        // test can pin the exact column list — a double that ignores its
        // select argument is how a column gets silently dropped from the
        // real query with no test noticing.
        select: (cols) => { selected = true; trace.push({ step: 'select', table, cols }); return b },
        eq: () => b,
        contains: () => b,
        // PERSON-ACCT.9 — the pending-approval dedupe matches across ALL of
        // this person's contact ids, so it filters with `.in()` rather than
        // `.eq()`. Without this the lookup throws and the dedupe silently
        // degrades to "no existing card".
        in: () => b,
        limit: () => b,
        async maybeSingle() {
          if (table === 'contacts') return { data: { glofox_member_id: 'gf-1', glofox_membership_status: membershipStatus, glofox_membership_state: membershipState }, error: null }
          return { data: null, error: null }
        },
        async single() { return { data: { id: 'req-1' }, error: null } },
        insert(row) {
          selected = false
          trace.push({ step: 'insert', table, status: row.status, reason: row.details?.reason || null })
          return b
        },
        update() { selected = false; trace.push({ step: 'update', table }); return b },
        then(resolve) {
          resolve({ data: selected && table === 'agent_membership_requests' ? pendingRows : null, error: null })
        },
      }
      return b
    },
  }
  return db
}

const ctx = (db) => ({
  db,
  conversationId: 'conv-1',
  conversationsTable: 'whatsapp_conversations',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  nameHint: 'Vanessa',
  settings: { booking_mode: 'auto' },
})

beforeEach(() => vi.clearAllMocks())

describe('book_class credit pre-flight', () => {
  it('confirmed-empty balance → no_credits + pending approval (reason no_credits) + staff notify, NO Glofox booking attempt', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'ENG1NE' }, ctx(stubDb(trace)))
    expect(res).toMatchObject({ booked: false, no_credits: true })
    expect(trace).toContainEqual(expect.objectContaining({ step: 'insert', table: 'agent_membership_requests', status: 'pending', reason: 'no_credits' }))
    expect(notifyAgentApprovalRequest).toHaveBeenCalledOnce()
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('credits available → proceeds to the booking', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [{ active: true, available: 2 }] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace)))
    expect(res.no_credits).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalled()
  })

  // PERSON-ACCT.3 — glofox_membership_status is NEVER the string 'active' in
  // prod; a bookable membership is status 'member'/'credit_member' with a
  // state that hasn't ended (hasBookableMembership, src/lib/person-accounts.js).
  it('empty credits but a bookable membership (member + active state) → proceeds (Glofox arbitrates)', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { membershipStatus: 'member', membershipState: 'active' })))
    expect(res.no_credits).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalled()
  })

  it('empty credits + a classpass_payg account with state active → STILL no_credits (classpass is never a bookable membership)', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { membershipStatus: 'classpass_payg', membershipState: 'active' })))
    expect(res).toMatchObject({ booked: false, no_credits: true })
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('UNREADABLE balance (Glofox blip) → proceeds, never escalates', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: false, credits: [] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace)))
    expect(res.no_credits).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalled()
  })

  it('deduped: an existing pending approval for the same contact+event is reused, no second card', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { pendingRows: [{ id: 'existing-1' }] })))
    expect(res).toMatchObject({ no_credits: true })
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  // Quality-review finding: stubDb used to return the fixture regardless of
  // what was requested, so the select() string itself was never exercised —
  // a future editor could drop glofox_membership_state from the query and
  // every test here would stay green while hasBookableMembership silently
  // returned false forever. Pin the column list, not just the shape it
  // happens to produce today.
  it('the contacts select includes glofox_membership_state and glofox_member_id (pins the widened column list)', async () => {
    glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
    const trace = []
    await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { membershipStatus: 'member', membershipState: 'active' })))
    const sel = trace.find((t) => t.step === 'select' && t.table === 'contacts')
    expect(sel).toBeTruthy()
    expect(sel.cols).toContain('glofox_membership_state')
    expect(sel.cols).toContain('glofox_member_id')
  })
})
