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
  cancelBooking: vi.fn(),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ ok: true })),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  buildDeclineNoticeText: vi.fn(() => "Sorry, we couldn't complete that request this time."),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))

import { createBooking, cancelBooking } from '@/lib/glofox'
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
// MIA-BOARD.2 — parameterised so the past-start guard tests can vary
// details.starts_at without mutating the shared ROW.
function makeDbFor(row, updates) {
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b,
        eq: () => b,
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() {
          if (patch) return { data: { id: row.id }, error: null } // claim succeeded
          if (table === 'contacts') return { data: { glofox_member_id: 'gm1' }, error: null }
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
function makeDb(updates) { return makeDbFor(ROW, updates) }

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

  // MIA-BOOK.2 — a clean 200 without an id is a real booking (Glofox's live
  // success shape never matched the harvest list).
  it('HTTP 200 with an idless body and no message code → actioned, confirmation sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: {} })

    await approve()

    expect(updates.at(-1).patch.status).toBe('actioned')
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

// APPROVALS-STUDIO.1 — a decline is never silence: the customer gets the
// operator-editable (default) decline notice in-thread.
describe('PATCH decline — customer notice', () => {
  it('declining a threaded request sends the decline notice', async () => {
    const res = await PATCH(
      new Request('http://localhost/api/agent/membership-requests/r1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'declined' }),
      }),
      { params: Promise.resolve({ id: 'r1' }) },
    )
    expect(res.status).toBe(200)
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    const sent = sendAgentThreadMessage.mock.calls[0][1]
    expect(sent.conversationId).toBe('conv1')
    expect(sent.text.length).toBeGreaterThan(10)
  })
})

// AGENT-RETRY.1 — a FAILED execution may be re-approved after the operator
// fixes the underlying problem in Glofox. The re-claim races on
// status='failed' (loser 409s); decline and non-executing kinds stay shut.
describe('PATCH failed-execution retry', () => {
  const FAILED_ROW = {
    ...ROW,
    status: 'failed',
    details: { ...ROW.details, reason: 'prior_attendance', result: { ok: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } },
  }

  // Same double as makeDb, but with an overridable row and eq capture on
  // update chains so the claim predicate is assertable.
  function makeRetryDb(updates, row, claimEqs) {
    return {
      from(table) {
        let patch = null
        const eqs = []
        const b = {
          select: () => b,
          eq(col, val) { eqs.push([col, val]); return b },
          update(p) { patch = p; updates.push({ table, patch: p, eqs }); return b },
          async maybeSingle() {
            if (patch) { claimEqs.push(...eqs); return { data: { id: row.id }, error: null } }
            if (table === 'contacts') return { data: { glofox_member_id: 'gm1' }, error: null }
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

  it('approve on a failed class_booking re-claims on status=failed and re-runs the booking', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const claimEqs = []
    db = makeRetryDb(updates, FAILED_ROW, claimEqs)
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-retry' } })

    const res = await approve()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.executed).toMatchObject({ ok: true, glofox_booking_id: 'gfb-retry' })
    // The claim raced on the failed status, not pending.
    expect(claimEqs).toContainEqual(['status', 'failed'])
    expect(updates.at(-1).patch.status).toBe('actioned')
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('a second failure overwrites result and lands failed again — still no confirmation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db = makeRetryDb(updates, FAILED_ROW, [])
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })

    await approve()

    expect(updates.at(-1).patch.status).toBe('failed')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('decline on a failed row still 409s', async () => {
    db = makeRetryDb(updates, FAILED_ROW, [])
    const res = await PATCH(
      new Request('http://localhost/api/agent/membership-requests/r1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'declined' }),
      }),
      { params: Promise.resolve({ id: 'r1' }) },
    )
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('approve on a failed NON-executing kind (pause) 409s', async () => {
    db = makeRetryDb(updates, { ...FAILED_ROW, kind: 'pause' }, [])
    const res = await approve()
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })
})

// MIA-BOARD.2 — the past-start guard. On 23 Aug two funnel bookings were
// approved at 8:26pm for classes that ran that morning; the executor booked
// them into Glofox anyway and CONFIRMED them to the customer. An approval
// whose class has already started must expire, never execute.
//
// MIA-EXPIRY-QUIET.1 (Richard, 2026-08-31) — and it must do so QUIETLY: the
// member is never messaged about a booking we missed, the team is.
describe('PATCH class_booking approval — past-start guard', () => {
  const pastRow = () => ({
    ...ROW,
    details: { ...ROW.details, starts_at: new Date(Date.now() - 3_600_000).toISOString() },
  })
  const futureRow = () => ({
    ...ROW,
    details: { ...ROW.details, starts_at: new Date(Date.now() + 3_600_000).toISOString() },
  })

  it('a booking whose class already started expires instead of executing', async () => {
    db = makeDbFor(pastRow(), updates)
    const res = await approve()
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(createBooking).not.toHaveBeenCalled()
    const final = updates.at(-1)
    expect(final.patch.status).toBe('expired')
    expect(final.patch.details.result).toMatchObject({ ok: false, reason: 'CLASS_ALREADY_STARTED' })
    // MIA-EXPIRY-QUIET.1 — the member hears nothing; staff follow up.
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('a booking with a future start executes normally', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { data: { _id: 'bk1' } } })
    db = makeDbFor(futureRow(), updates)
    const res = await approve()
    expect((await res.json()).success).toBe(true)
    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('a row with no starts_at is not guarded (legacy shape) and executes', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { data: { _id: 'bk1' } } })
    db = makeDbFor({ ...ROW }, updates)
    const res = await approve()
    expect((await res.json()).success).toBe(true)
    expect(createBooking).toHaveBeenCalledTimes(1)
  })
})

// PERSON-ACCT.7 — the executor's account cross-check. book_class elects ONE
// of a person's linked Glofox accounts and stamps it on the row; by the time
// staff approve, that contact's link may have been repointed (a merge, a
// re-sync, a manual fix). Executing anyway books a class on an account
// nobody chose — so the row lands 'failed' with ACCOUNT_MISMATCH and rides
// the existing Fix & retry lane instead.
describe('PATCH class_booking approval — elected-account cross-check', () => {
  const electedRow = (memberId) => ({ ...ROW, details: { ...ROW.details, elected_glofox_member_id: memberId } })

  it('elected account no longer matches the contact → failed ACCOUNT_MISMATCH, NO Glofox call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db = makeDbFor(electedRow('gm-elsewhere'), updates)

    const res = await approve()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(createBooking).not.toHaveBeenCalled()
    expect(json.executed).toMatchObject({ ok: false, message_code: 'ACCOUNT_MISMATCH' })
    const final = updates.at(-1).patch
    expect(final.status).toBe('failed')
    expect(final.details.result).toMatchObject({ ok: false, message_code: 'ACCOUNT_MISMATCH' })
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('elected account still matches → executes normally', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-ok' } })
    db = makeDbFor(electedRow('gm1'), updates)

    await approve()

    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(createBooking.mock.calls[0][1]).toMatchObject({ user_id: 'gm1' })
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('a legacy row with no elected stamp is not cross-checked (unchanged)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-legacy' } })
    db = makeDbFor({ ...ROW }, updates)

    await approve()

    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(updates.at(-1).patch.status).toBe('actioned')
  })
})

// PERSON-ACCT.9 — the /start funnel reuses a corroborated SIBLING's Glofox
// account instead of minting a duplicate, so the approval row is filed against
// the funnel contact (attribution — its ctwa_clid, and the phone the
// confirmation goes to) while the write belongs to the sibling's account.
// Executing against row.contact_id would read an empty glofox_member_id and
// answer NOT_EXECUTABLE on a booking staff can see is ready to go.
describe('PATCH class_booking approval — executing-contact override', () => {
  // Same double, except the contacts read HONOURS its id filter — the whole
  // point of the override is which row gets read.
  function makeDbForPerson(row, updates, membersById) {
    const reads = []
    const db = {
      reads,
      from(table) {
        let patch = null
        let contactId = null
        const b = {
          select: () => b,
          eq(col, val) { if (col === 'id') contactId = val; return b },
          update(p) { patch = p; updates.push({ table, patch: p }); return b },
          async maybeSingle() {
            if (patch) return { data: { id: row.id }, error: null }
            if (table === 'contacts') {
              reads.push(contactId)
              return { data: { glofox_member_id: membersById[contactId] ?? null }, error: null }
            }
            return { data: row, error: null }
          },
          async single() {
            return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null }
          },
        }
        return b
      },
    }
    return db
  }

  it('books against details.executing_contact_id\'s account, not the row contact\'s', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-sib' } })
    const row = {
      ...ROW,
      contact_id: 'c-funnel',
      conversation_id: null,
      details: { ...ROW.details, executing_contact_id: 'c-sibling', elected_glofox_member_id: 'gm-sibling' },
    }
    db = makeDbForPerson(row, updates, { 'c-funnel': null, 'c-sibling': 'gm-sibling' })

    await approve()

    expect(db.reads).toContain('c-sibling')
    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(createBooking.mock.calls[0][1]).toMatchObject({ user_id: 'gm-sibling' })
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('the elected cross-check still applies to the EXECUTING contact (repointed link → ACCOUNT_MISMATCH)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = {
      ...ROW,
      contact_id: 'c-funnel',
      details: { ...ROW.details, executing_contact_id: 'c-sibling', elected_glofox_member_id: 'gm-sibling' },
    }
    db = makeDbForPerson(row, updates, { 'c-funnel': 'gm-sibling', 'c-sibling': 'gm-moved' })

    const res = await approve()
    const json = await res.json()

    expect(createBooking).not.toHaveBeenCalled()
    expect(json.executed).toMatchObject({ ok: false, message_code: 'ACCOUNT_MISMATCH' })
    warn.mockRestore()
  })

  it('no override → reads the row contact exactly as before', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-own' } })
    db = makeDbForPerson({ ...ROW, conversation_id: null }, updates, { c1: 'gm1' })

    await approve()

    expect(db.reads).toEqual(['c1'])
    expect(createBooking.mock.calls[0][1]).toMatchObject({ user_id: 'gm1' })
  })
})

// PERSON-ACCT.7 — a cancellation drafted for a booking that lives on a
// SIBLING account carries details.executing_glofox_member_id. The executor
// used to cancel against row.contact_id's account unconditionally, which is
// why PR1 refused to draft those at all.
describe('PATCH class_cancellation approval — executing account override', () => {
  const cancelRow = (details) => ({
    ...ROW,
    kind: 'class_cancellation',
    details: { booking_id: '64bb00000000000000000001', class_name: 'ARENA', class_time: 'Mon 06:15', ...details },
  })

  it('honours details.executing_glofox_member_id — cancels against THAT account', async () => {
    cancelBooking.mockResolvedValueOnce({ ok: true, status: 200, body: {} })
    db = makeDbFor(cancelRow({ executing_glofox_member_id: 'gm-sibling', executing_contact_id: 'c-2' }), updates)

    const res = await approve()
    const json = await res.json()

    expect(json.executed).toMatchObject({ ok: true })
    expect(cancelBooking).toHaveBeenCalledWith(expect.anything(), '64bb00000000000000000001', 'gm-sibling')
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('no override → cancels against the row contact\'s own account (unchanged)', async () => {
    cancelBooking.mockResolvedValueOnce({ ok: true, status: 200, body: {} })
    db = makeDbFor(cancelRow({}), updates)

    await approve()

    expect(cancelBooking).toHaveBeenCalledWith(expect.anything(), '64bb00000000000000000001', 'gm1')
  })
})
