// MIA-REVIEW.3 (3.14) — invariant 7 says EVERY booking attempt writes an
// agent_membership_requests row. In auto mode the row used to be written
// AFTER createBooking/cancelBooking returned, so a crash or timeout between
// the Glofox call and the log left a real booking with no audit row at all —
// the trail could never be treated as complete for reconciliation. The intent
// row now goes in FIRST (status 'pending', details.stage 'executing') and is
// finalised afterwards, the way the draft path always worked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Partial mock: interpretBookingResult stays REAL — these tests assert the
// booked/failed/pending-fallback judgement, so the actual body-interpretation
// logic must run (MIA-BOOKCHECK.1 + MIA-BOOK.1).
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  GLOFOX_BOOKING_MODEL: 'events',
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
  fetchUpcomingEvents: vi.fn(),
  fetchMemberBookings: vi.fn(),
  // PERSON-ACCT.2 — cancel now locates the booking's owning account before
  // executing. Here the anchor's own account holds it, so the trace below is
  // unchanged.
  // (the id literal is repeated rather than referencing EVENT_ID — the mock
  // factory is hoisted above the const, so the binding is in its TDZ here)
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [{ _id: '64aa00000000000000000001' }] })),
}))

import * as glofox from '@/lib/glofox'
import { executeBookingTool } from './booking-tools'

const EVENT_ID = '64aa00000000000000000001'

// Records every audit write and the Glofox call in one ordered trace.
// pendingLookupRows feeds the MIA-BOOK.1 dedup select (existing pending
// approvals for the same contact+event).
function auditDb(trace, { insertId = 'req-1', insertThrows = false } = {}) {
  const db = {
    pendingLookupRows: null,
    from(table) {
      let selected = false
      const b = {
        select: () => { selected = true; return b },
        eq: () => b,
        contains: () => b,
        limit: () => b,
        async maybeSingle() {
          if (table === 'contacts') return { data: { glofox_member_id: 'gf-1' }, error: null }
          return { data: null, error: null }
        },
        async single() { return { data: { id: insertId }, error: null } },
        insert(row) {
          selected = false
          trace.push({ step: 'audit_insert', table, status: row.status, stage: row.details?.stage || null })
          if (insertThrows) throw new Error('audit table unavailable')
          return b
        },
        update(patch) {
          selected = false
          trace.push({
            step: 'audit_update', table, status: patch.status, details: patch.details,
            glofoxBookingId: patch.details?.result?.glofox_booking_id ?? null,
          })
          return b
        },
        then(resolve) {
          // PERSON-ACCT.2 — linkedAccountsForContact reads the person's
          // contacts rows through an awaited (non-maybeSingle) builder. One
          // ungrouped contact, linked to gf-1: the same single account this
          // file always modelled.
          if (selected && table === 'contacts') {
            resolve({ data: [{ id: 'c-1', glofox_member_id: 'gf-1', glofox_membership_status: 'member', phone: '+353871234567', wa_phone: null, email: 'a@example.com' }], error: null })
            return
          }
          resolve({ data: selected && table === 'agent_membership_requests' ? db.pendingLookupRows : null, error: null })
        },
      }
      return b
    },
  }
  return db
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
      return { ok: true, status: 200, body: { _id: 'gfb-1' } }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'ARENA' }, ctx(trace))

    expect(res).toMatchObject({ booked: true })
    expect(trace.map(t => t.step)).toEqual(['audit_insert', 'glofox_createBooking', 'audit_update'])
    expect(trace[0]).toMatchObject({ status: 'pending', stage: 'executing' })
    // The harvested Glofox booking id lands in details.result so agent
    // bookings can be reconciled against Glofox.
    expect(trace[2]).toMatchObject({ status: 'actioned', glofoxBookingId: 'gfb-1' })
  })

  // MIA-BOOKCHECK — Glofox 200s with a failure body (message_code
  // YOU_HAVE_NO_CREDITS_LEFT, live 2026-07-27 Lucinda Kinghan / 2026-07-22
  // Colm Keegan): HTTP ok alone must NOT finalize as actioned/booked.
  it('HTTP 200 with a failure body → booked:false, audit row failed (never actioned)', async () => {
    const trace = []
    glofox.createBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_createBooking' })
      return { ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'ARENA' }, ctx(trace))

    // MIA-BOOK.1 — account-shaped rejections now fall back to a PENDING
    // approval instead of a plain failure (never actioned either way).
    expect(res).toMatchObject({ booked: false, reason: 'YOU_HAVE_NO_CREDITS_LEFT', requested: true })
    expect(trace.at(-1)).toMatchObject({ step: 'audit_update', status: 'pending' })
  })

  // MIA-BOOK.2 — a CLEAN 2xx (no message code) is a real booking even when
  // no id can be harvested (Glofox's live success shape never matched the
  // harvest list; Emma Kennedy 2026-07-28).
  it('HTTP 200 with no booking id and no message code → booked:true', async () => {
    const trace = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    glofox.createBooking.mockImplementation(async () => {
      trace.push({ step: 'glofox_createBooking' })
      return { ok: true, status: 200, body: {} }
    })

    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))

    expect(res).toMatchObject({ booked: true })
    expect(trace.at(-1)).toMatchObject({ step: 'audit_update', status: 'actioned' })
    warn.mockRestore()
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
      return { ok: true, status: 200, body: { _id: 'gfb-2' } }
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

// MIA-BOOK.1 — Glofox reports many rejections IN-BODY with an HTTP 200
// (live-observed 2026-07-27: 200 + YOU_HAVE_NO_CREDITS_LEFT booked nothing,
// and the customer was told "you're booked in"). Account-shaped rejections
// become a PENDING approval a human resolves; venue-shaped ones stay an
// honest in-chat failure.
describe('in-body Glofox rejections (MIA-BOOK.1)', () => {
  it('a 200 + YOU_HAVE_NO_CREDITS_LEFT finalises the row PENDING (approval fallback), never booked:true', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'SQUAD' }, ctx(trace))
    expect(res.booked).not.toBe(true)
    expect(res.requested).toBe(true)
    expect(res.message).toContain('handing this over to the team')
    expect(trace.map(t => t.step)).toEqual(['audit_insert', 'audit_update'])
    expect(trace[1]).toMatchObject({ status: 'pending' })
    expect(trace[1].details.summary).toContain('YOU_HAVE_NO_CREDITS_LEFT')
    expect(trace[1].details.reason).toBe('booking_rejected')
  })

  it('honours the operator handoff copy override', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const c = ctx(trace)
    c.settings = { booking_mode: 'auto', booking_issue_handoff_text: 'Account hiccup, the crew will ping you.' }
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, c)
    expect(res.message).toContain('Account hiccup, the crew will ping you.')
  })

  it('EVENT_HAS_BEEN_CANCELLED stays an honest in-chat failure (no approval)', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'EVENT_HAS_BEEN_CANCELLED' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(res).toMatchObject({ booked: false, reason: 'EVENT_HAS_BEEN_CANCELLED' })
    expect(res.requested).toBeUndefined()
    expect(trace[1]).toMatchObject({ status: 'failed' })
  })

  it('already-booked reads as success', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(res.booked).toBe(true)
    expect(trace[1]).toMatchObject({ status: 'actioned' })
  })

  it('a success stores the glofox booking id on the audit row', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { id: 'gfb-1' } })
    await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(trace[1]).toMatchObject({ status: 'actioned' })
    expect(trace[1].details.result.glofox_booking_id).toBe('gfb-1')
  })

  it('a second rejection for the same contact+event supersedes instead of double-carding', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const c = ctx(trace)
    c.db.pendingLookupRows = [{ id: 'req-existing' }]
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, c)
    expect(res.requested).toBe(true)                       // customer experience identical
    expect(trace[1]).toMatchObject({ status: 'failed' })   // no second pending card
    expect(trace[1].details.reason).toBe('superseded_duplicate')
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
