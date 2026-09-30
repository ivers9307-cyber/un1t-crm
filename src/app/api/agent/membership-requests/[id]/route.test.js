// MIA-BOOKCHECK — approving a class_booking executes createBooking, and
// Glofox can return HTTP 200 with a failure body (message_code
// YOU_HAVE_NO_CREDITS_LEFT, live 2026-07-27). The route must judge success
// on the created booking id (interpretBookingResult — REAL here, only the
// HTTP call is mocked), land the row on 'failed', and never send the
// in-thread confirmation for a booking that did not happen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  purchaseGlofoxMembership: vi.fn(async () => ({ ok: true })),
  // TRIALGRANT.1 — the grant re-reads credits first; by default the account
  // is empty, so a needs_credit_grant approval buys the trial.
  fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
}))
// CBPCREDITREAD.1 / TRIALGRANT.1 — the trial grant reads the location's trial
// plan with readGlofoxConfig (a failed read is its own failure, never "not
// configured"); configured here so only the card's reason decides whether it
// fires.
vi.mock('@/lib/connection-registry', async (importOriginal) => ({
  ...(await importOriginal()),
  readGlofoxConfig: vi.fn(async () => ({ cfg: { trial_membership_id: 'tm-1', trial_plan_code: 'tp-1' }, error: null })),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ ok: true })),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  buildDeclineNoticeText: vi.fn(() => "Sorry, we couldn't complete that request this time."),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))

import { createBooking, cancelBooking, glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, purchaseGlofoxMembership, fetchUserCreditsResult } from '@/lib/glofox'
import { readGlofoxConfig } from '@/lib/connection-registry'
import { failureExplanation } from '@/lib/approvals/agent-request-why'
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

  // GLOFOXWRITEJUDGE.1 — Glofox: a 200 with success:false is a bad request,
  // even with no code. It used to approve as booked and confirm to the member.
  it('HTTP 200 success:false with no code and no id → row failed, NO confirmation sent', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: false } })

    const res = await approve()
    const json = await res.json()

    expect(json.executed).toMatchObject({ ok: false, status: 200, message_code: null, glofox_booking_id: null })
    expect(updates.at(-1).patch.status).toBe('failed')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
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

describe('PATCH approval — REGISTRYREAD.1a unreadable Glofox settings', () => {
  const UNREADABLE = { branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' }
  const realMissing = (c) => ['Branch ID', 'API Key', 'API Token'].filter((_, i) => ![c?.branchId, c?.apiKey, c?.apiToken][i])
  beforeEach(() => { missingGlofoxCredentialsForLocation.mockImplementation(realMissing) })
  afterEach(() => { missingGlofoxCredentialsForLocation.mockImplementation(() => []) })

  it('class_booking: failed with GLOFOX_SETTINGS_UNREADABLE (not NOT_EXECUTABLE); no Glofox call; no confirmation', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce(UNREADABLE)
    await approve()
    const final = updates.at(-1).patch
    expect(final.status).toBe('failed')
    expect(final.details.result).toEqual({ ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' })
    expect(createBooking).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('class_cancellation: the same', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce(UNREADABLE)
    db = makeDbFor({ ...ROW, kind: 'class_cancellation', details: { booking_id: '64bb00000000000000000001', class_name: 'ARENA', class_time: 'Mon 06:15' } }, updates)
    await approve()
    const final = updates.at(-1).patch
    expect(final.status).toBe('failed')
    expect(final.details.result).toEqual({ ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' })
    expect(cancelBooking).not.toHaveBeenCalled()
  })
})

// CBPCREDITREAD.1 — approving needs_credit_grant BUYS the trial membership
// before booking (the purchaseGlofoxMembership call in route.js). A
// credit_check_failed card is an UNKNOWN balance: the member may already hold
// a paid pack, so approving it must buy nothing, and still book.
describe('PATCH class_booking approval — trial grant only on needs_credit_grant', () => {
  const rowWith = (reason) => ({ ...ROW, details: { ...ROW.details, reason, source: 'start_funnel' } })

  it('needs_credit_grant: buys the trial on the account, then books (the call site is live)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-1' } })
    db = makeDbFor(rowWith('needs_credit_grant'), updates)

    await approve()

    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(expect.anything(), 'gm1', 'tm-1', 'tp-1')
    expect(createBooking).toHaveBeenCalledTimes(1)
  })

  it('credit_check_failed: buys NOTHING, and still books against the account', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { _id: 'gfb-1' } })
    db = makeDbFor(rowWith('credit_check_failed'), updates)

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(createBooking.mock.calls[0][1]).toMatchObject({ user_id: 'gm1' })
  })
})

// TRIALGRANT.1 — the trial purchase is JUDGED before the booking. It used to
// be fire-and-forget: a refusal (Glofox 200s with success:false) went
// straight on to createBooking, failed YOU_HAVE_NO_CREDITS_LEFT, and a
// Fix & retry bought the trial again.
describe('PATCH class_booking approval — the trial grant is judged (TRIALGRANT.1)', () => {
  const grantRow = (extra = {}) => ({ ...ROW, details: { ...ROW.details, reason: 'needs_credit_grant', source: 'start_funnel', ...extra } })

  it('purchase refused → failed TRIAL_GRANT_FAILED, NO booking attempt, NO confirmation, queue row synced', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, http_status: 200, message_code: 'PURCHASE_NOT_ALLOWED', purchase_status: 'ERROR', error: 'Membership cannot be purchased' })
    db = makeDbFor(grantRow(), updates)

    const json = await (await approve()).json()

    expect(createBooking).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(json.executed).toMatchObject({ ok: false, message_code: 'TRIAL_GRANT_FAILED', glofox_message_code: 'PURCHASE_NOT_ALLOWED' })
    const final = updates.at(-1).patch
    expect(final.status).toBe('failed')
    expect(final.details.trial_grant).toMatchObject({ ok: false, code: 'TRIAL_GRANT_FAILED' })
    expect(final.details.execution.stage).toBe('done')
    const cbr = updates.find((u) => u.table === 'class_booking_requests')
    expect(cbr.patch).toEqual({ status: 'failed', last_error: 'TRIAL_GRANT_FAILED' })
    expect(failureExplanation({ status: 'failed', details: final.details })).toMatch(/PURCHASE_NOT_ALLOWED/)
  })

  it('purchase granted → books; the grant is recorded on details and on executed', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-7' } } })
    db = makeDbFor(grantRow(), updates)

    const json = await (await approve()).json()

    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(json.executed).toMatchObject({ ok: true, glofox_booking_id: 'gfb-7', trial_grant: { ok: true, invoice_id: 'inv-1' } })
    expect(updates.at(-1).patch.status).toBe('actioned')
    expect(updates.at(-1).patch.details.trial_grant).toMatchObject({ ok: true, invoice_id: 'inv-1' })
  })

  // GLOFOXPOSTRETRY.1 review — a booking found landed after a 5xx is kept
  // visible on the card's result, for audit.
  it('a booking recovered after a 5xx records recovered on the result', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-r' } }, recovered: 'landed_after_5xx' })
    db = makeDbFor(grantRow(), updates)

    const json = await (await approve()).json()

    expect(json.executed).toMatchObject({ ok: true, glofox_booking_id: 'gfb-r', recovered: 'landed_after_5xx' })
    expect(updates.at(-1).patch.details.result.recovered).toBe('landed_after_5xx')
  })

  it('Fix & retry on a card whose trial WAS granted buys nothing more, and books', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-8' } } })
    db = makeDbFor({ ...grantRow({ trial_grant: { ok: true, at: '2026-09-30T18:00:00.000Z', invoice_id: 'inv-0' }, result: { ok: false, message_code: 'CLASS_IS_FULL' } }), status: 'failed' }, updates)

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(fetchUserCreditsResult).not.toHaveBeenCalled()
    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('trial granted but Glofox still refuses no-credits → failed, and the card says the trial was added', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    db = makeDbFor(grantRow(), updates)

    const json = await (await approve()).json()

    expect(updates.at(-1).patch.status).toBe('failed')
    expect(json.executed.trial_grant).toMatchObject({ ok: true })
    expect(failureExplanation({ status: 'failed', details: { result: json.executed } })).toMatch(/trial was added/i)
  })

  // The route must tell the helper this is a retry: an earlier attempt may
  // have bought the trial without recording it, so an unreadable balance on
  // a retry buys nothing (a first approval still buys, as before).
  it('Fix & retry with an unreadable balance → failed TRIAL_GRANT_UNVERIFIED, nothing bought, no booking', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce({ ok: false, credits: [] })
    db = makeDbFor({ ...grantRow({ trial_grant: { ok: false, code: 'TRIAL_GRANT_FAILED' }, result: { ok: false, message_code: 'TRIAL_GRANT_FAILED' } }), status: 'failed' }, updates)

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(createBooking).not.toHaveBeenCalled()
    expect(updates.at(-1).patch.status).toBe('failed')
    expect(updates.at(-1).patch.details.result).toMatchObject({ ok: false, message_code: 'TRIAL_GRANT_UNVERIFIED' })
  })

  // GLOFOXPOSTRETRY.1 review — the /start mint's purchase got no clear
  // answer and the processor stamped the card. Its FIRST approval must not
  // buy a second trial: no credits showing → failed TRIAL_GRANT_UNVERIFIED.
  it('FIRST approval of a card stamped unsettled at the mint: nothing bought, no booking, UNVERIFIED', async () => {
    db = makeDbFor(grantRow({ trial_grant: { ok: false, code: 'TRIAL_GRANT_FAILED', outcome_unknown: true } }), updates)

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(createBooking).not.toHaveBeenCalled()
    expect(updates.at(-1).patch.status).toBe('failed')
    expect(updates.at(-1).patch.details.result).toMatchObject({ ok: false, message_code: 'TRIAL_GRANT_UNVERIFIED', outcome_unknown: true })
  })

  it('a card carrying the funnel’s trial override buys that trial, not the location default', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-9' } } })
    db = makeDbFor(grantRow({ trial_membership_id: 'tm-funnel', trial_plan_code: 'tp-funnel' }), updates)

    await approve()

    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(expect.anything(), 'gm1', 'tm-funnel', 'tp-funnel')
    expect(readGlofoxConfig).not.toHaveBeenCalled()
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('unreadable trial settings → failed GLOFOX_SETTINGS_UNREADABLE, no booking (was: silently "not configured", then booked)', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: { message: 'boom' } })
    db = makeDbFor(grantRow(), updates)

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(createBooking).not.toHaveBeenCalled()
    expect(updates.at(-1).patch.details.result).toMatchObject({ ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' })
  })
})

// Review should-fix — the write-ahead grant record. The grant used to reach
// the row only in the FINAL update, so a purchase that went through followed
// by a death before that write (createBooking stuck in Glofox backoff until
// the function timed out) left a stuck card with no record, and its retry
// could buy a second trial. These drive the real helper through a double
// that records every update WITH its filters.
describe('PATCH class_booking approval — the trial grant is written ahead (TRIALGRANT.1)', () => {
  const STALE = '2026-01-01T00:00:00.000Z' // long past EXECUTION_STALE_MS
  const grantRow = (extra = {}) => ({ ...ROW, details: { ...ROW.details, reason: 'needs_credit_grant', source: 'start_funnel', ...extra } })

  // A record write is an agent_membership_requests update with no `status`
  // (the claim and the final write both carry one). `failRecord` decides
  // which of them the database "loses".
  function makeGrantDb(row, log, { failRecord = () => false } = {}) {
    return {
      from(table) {
        let patch = null
        const eqs = []
        const b = {
          select: () => b,
          eq: (col, val) => { eqs.push([col, val]); return b },
          update(p) { patch = p; log.push({ table, patch: p, eqs }); return b },
          async maybeSingle() {
            if (patch) {
              const isRecord = table === 'agent_membership_requests' && !('status' in patch)
              if (isRecord && failRecord(patch.details?.trial_grant)) return { data: null, error: null }
              return { data: { id: row.id }, error: null }
            }
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
  const records = (log) => log.filter((u) => u.table === 'agent_membership_requests' && !('status' in u.patch))
  // What the row holds after the run: the last write that landed.
  const lastDetails = (log, landed = () => true) => records(log).filter((u) => landed(u.patch.details.trial_grant)).at(-1).patch.details

  it('writes the purchasing marker, then the outcome, on THIS execution only, before booking', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-1' } } })
    db = makeGrantDb(grantRow(), updates)

    await approve()

    const recs = records(updates)
    expect(recs.map((u) => u.patch.details.trial_grant)).toEqual([
      { stage: 'purchasing', at: expect.any(String) },
      expect.objectContaining({ ok: true, invoice_id: 'inv-1' }),
    ])
    const claim = updates.find((u) => u.table === 'agent_membership_requests' && u.patch.status === 'approved')
    const startedAt = claim.patch.details.execution.started_at
    for (const u of recs) {
      expect(u.eqs).toEqual(expect.arrayContaining([['id', 'r1'], ['details->execution->>started_at', startedAt]]))
      expect(u.patch.details.execution).toMatchObject({ stage: 'executing', started_at: startedAt })
    }
    expect(purchaseGlofoxMembership.mock.invocationCallOrder[0]).toBeLessThan(createBooking.mock.invocationCallOrder[0])
    expect(updates.at(-1).patch.status).toBe('actioned')
  })

  it('the marker cannot be written → failed TRIAL_GRANT_UNRECORDED; nothing bought, nothing booked', async () => {
    db = makeGrantDb(grantRow(), updates, { failRecord: (g) => g?.stage === 'purchasing' })

    await approve()

    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(createBooking).not.toHaveBeenCalled()
    expect(updates.at(-1).patch.status).toBe('failed')
    expect(updates.at(-1).patch.details.result).toMatchObject({ ok: false, message_code: 'TRIAL_GRANT_UNRECORDED' })
  })

  it('crash AFTER a recorded purchase (booking dies, no final write) → the stuck retry buys nothing more, and books', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockRejectedValueOnce(new Error('function timed out'))
    db = makeGrantDb(grantRow(), updates)
    await expect(approve()).rejects.toThrow('function timed out')
    expect(updates.some((u) => u.patch.status === 'actioned' || u.patch.status === 'failed')).toBe(false)

    // The row as the database now holds it: approved, executing, stale.
    const held = lastDetails(updates)
    const stuck = { ...ROW, status: 'approved', details: { ...held, execution: { ...held.execution, started_at: STALE } } }
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-2' } } })
    const retryLog = []
    db = makeGrantDb(stuck, retryLog)
    await approve()

    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(createBooking).toHaveBeenCalledTimes(2)
    expect(retryLog.at(-1).patch.status).toBe('actioned')
  })

  it('crash between the purchase and its outcome write → the retry, with no credits showing, refuses (TRIAL_GRANT_UNVERIFIED)', async () => {
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true, http_status: 200, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })
    createBooking.mockRejectedValueOnce(new Error('function timed out'))
    db = makeGrantDb(grantRow(), updates, { failRecord: (g) => g?.ok === true })
    await expect(approve()).rejects.toThrow('function timed out')

    // Only the marker landed; the trial is queued behind a membership they
    // hold, so no credits show yet.
    const held = lastDetails(updates, (g) => g?.stage === 'purchasing')
    expect(held.trial_grant).toEqual({ stage: 'purchasing', at: expect.any(String) })
    const stuck = { ...ROW, status: 'approved', details: { ...held, execution: { ...held.execution, started_at: STALE } } }
    const retryLog = []
    db = makeGrantDb(stuck, retryLog)
    await approve()

    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(createBooking).toHaveBeenCalledTimes(1)
    expect(retryLog.at(-1).patch.status).toBe('failed')
    expect(retryLog.at(-1).patch.details.result).toMatchObject({ ok: false, message_code: 'TRIAL_GRANT_UNVERIFIED' })
  })
})
