// MIA-REVIEW.3 (3.14) — invariant 7 says EVERY booking attempt writes an
// agent_membership_requests row. In auto mode the row used to be written
// AFTER createBooking/cancelBooking returned, so a crash or timeout between
// the Glofox call and the log left a real booking with no audit row at all —
// the trail could never be treated as complete for reconciliation. The intent
// row now goes in FIRST (status 'pending', details.stage 'executing') and is
// finalised afterwards, the way the draft path always worked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  GLOFOX_BOOKING_MODEL: 'events',
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
  fetchUpcomingEvents: vi.fn(),
  fetchMemberBookings: vi.fn(),
}))

import * as glofox from '@/lib/glofox'
import { executeBookingTool } from './booking-tools'

const EVENT_ID = '64aa00000000000000000001'

// Records every audit write and the Glofox call in one ordered trace.
function auditDb(trace, { insertId = 'req-1', insertThrows = false } = {}) {
  return {
    from(table) {
      const b = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        async maybeSingle() {
          if (table === 'contacts') return { data: { glofox_member_id: 'gf-1' }, error: null }
          return { data: null, error: null }
        },
        async single() { return { data: { id: insertId }, error: null } },
        insert(row) {
          trace.push({ step: 'audit_insert', table, status: row.status, stage: row.details?.stage || null })
          if (insertThrows) throw new Error('audit table unavailable')
          return b
        },
        update(patch) {
          trace.push({ step: 'audit_update', table, status: patch.status })
          return b
        },
        then(resolve) { resolve({ data: null, error: null }) },
      }
      return b
    },
  }
}

const ctx = (trace, opts) => ({
  db: auditDb(trace, opts),
  conversationId: 'conv-1',
  conversationsTable: 'whatsapp_conversations',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  settings: { booking_mode: 'auto' },
})

beforeEach(() => {
  vi.clearAllMocks()
  glofox.glofoxCredentialsForLocation.mockResolvedValue({ token: 'x' })
  glofox.missingGlofoxCredentialsForLocation.mockReturnValue([])
})

describe('auto-mode class booking writes the audit intent BEFORE the Glofox call', () => {
  it('insert(pending/executing) → createBooking → update(actioned)', async () => {
    const trace = []
    glofox.createBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_createBooking' })
      return { ok: true, status: 200, body: {} }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'ARENA' }, ctx(trace))

    expect(res).toMatchObject({ booked: true })
    expect(trace.map(t => t.step)).toEqual(['audit_insert', 'glofox_createBooking', 'audit_update'])
    expect(trace[0]).toMatchObject({ status: 'pending', stage: 'executing' })
    expect(trace[2]).toMatchObject({ status: 'actioned' })
  })

  it('a FAILED booking finalises the same row as failed (still one row, not two)', async () => {
    const trace = []
    glofox.createBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_createBooking' })
      return { ok: false, status: 400, body: { message_code: 'EVENT_FULL' } }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))

    expect(res).toMatchObject({ booked: false, reason: 'EVENT_FULL' })
    expect(trace.filter(t => t.step === 'audit_insert')).toHaveLength(1)
    expect(trace.at(-1)).toMatchObject({ step: 'audit_update', status: 'failed' })
  })

  it('if the intent insert fails, the outcome is still recorded (fallback insert) and the customer is unaffected', async () => {
    const trace = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    glofox.createBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_createBooking' })
      return { ok: true, status: 200, body: {} }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace, { insertThrows: true }))

    expect(res).toMatchObject({ booked: true })
    // First insert threw (logged, non-blocking); the finalise fell back to a
    // fresh insert rather than updating a row that does not exist.
    expect(trace.filter(t => t.step === 'audit_update')).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('auto-mode class cancellation does the same', () => {
  it('insert(pending/executing) → cancelBooking → update(actioned)', async () => {
    const trace = []
    glofox.cancelBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_cancelBooking' })
      return { ok: true, status: 200, body: {} }
    })

    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: EVENT_ID, class_name: 'ARENA' }, ctx(trace))

    expect(res).toMatchObject({ cancelled: true })
    expect(trace.map(t => t.step)).toEqual(['audit_insert', 'glofox_cancelBooking', 'audit_update'])
    expect(trace[0]).toMatchObject({ status: 'pending', stage: 'executing' })
  })
})
