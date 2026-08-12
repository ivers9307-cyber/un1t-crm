// EMAIL-PARTICIPANTS.6 — the only writer of email_tickets.excluded_participants.
//
// The audience itself is DERIVED from the thread on every read, so it cannot
// drift; the operator's subtractions are the one piece of stored state, and
// this route is the one thing that stores them. Two properties carry the
// feature:
//
//   1. WHAT IS STORED IS NORMALISED. resolveReplyAudience matches exclusions
//      against normalised addresses, so a removal written as the operator typed
//      it ('Rates@Council.IE') would never match the derived 'rates@council.ie'
//      — the button would appear to work and the next reply would mail them
//      anyway. Silent, and exactly the failure mode this programme exists to
//      end.
//   2. IT IS UNDOABLE. `restore` takes an address back off the list, matched on
//      the normalised form so the case the operator happens to type cannot
//      strand an exclusion nobody can lift.
//
// The gate is loadTicketForUser and the refusal is 404 — the same posture as
// every other ticket route, tested with the REAL permission resolver rather
// than a mocked hasPermission (six email route test files once mocked it, and
// a real cross-location authorization bug shipped underneath).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PATCH } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, failWrites, updatesTo, writesTo } from '../../_test-db'
import {
  T_STUDIO, T_OTHER_LOCATION, COACH, GRANT_STUDIO, baseState,
} from '../../_test-fixtures'

function patch(id, body) {
  return PATCH(
    new Request(`http://x/api/email/tickets/${id}/participants`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

let db
function setupDb(extra = {}) {
  db = makeDb(baseState({ grants: [GRANT_STUDIO], ...extra }))
  createServerClient.mockImplementation(() => db)
  return db
}

/** What the route actually put on the wire for this ticket. */
const written = () => updatesTo(db, 'email_tickets')[0]?.payload?.excluded_participants
/** …and what the row holds afterwards. */
const stored = () => db._state.tickets.find(t => t.id === T_STUDIO.id).excluded_participants

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  setupDb()
})

describe('PATCH …/participants', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch(T_STUDIO.id, { remove: ['rates@council.ie'] })).status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  // The whole point of writing normalised: resolveReplyAudience compares
  // against normalizeAddressList()'d addresses, so a stored 'Rates@Council.IE'
  // would silently never match and the removal would be cosmetic.
  it('removes an address and stores it NORMALISED', async () => {
    const res = await patch(T_STUDIO.id, { remove: ['Rates@Council.IE'] })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ excluded_participants: ['rates@council.ie'] })
    expect(written()).toEqual(['rates@council.ie'])
    expect(stored()).toEqual(['rates@council.ie'])
  })

  // The undo. Matched on the NORMALISED form too — an exclusion an operator
  // could see but never lift would be worse than not offering the button.
  it('restore takes an address back off the exclusion list', async () => {
    setupDb({ tickets: [{ ...T_STUDIO, excluded_participants: ['rates@council.ie'] }] })

    const res = await patch(T_STUDIO.id, { restore: ['Rates@Council.IE'] })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ excluded_participants: [] })
    expect(written()).toEqual([])
    expect(stored()).toEqual([])
  })

  // The UI re-sends whatever the operator clicked; a double-click must not
  // grow the column.
  it('is idempotent — removing an already-excluded address does not duplicate it', async () => {
    setupDb({ tickets: [{ ...T_STUDIO, excluded_participants: ['rates@council.ie'] }] })

    const res = await patch(T_STUDIO.id, { remove: ['rates@council.ie'] })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ excluded_participants: ['rates@council.ie'] })
    expect(written()).toEqual(['rates@council.ie'])
  })

  // PRECEDENCE, PINNED. `remove` is applied after the `restore` filter, so a
  // contradictory body lands on the NARROWER audience — the safe reading on a
  // surface whose purpose is taking people off a thread. Documented in-source,
  // but undocumented-by-test precedence is how a refactor flips it silently.
  it('resolves an address named in BOTH lists as removed', async () => {
    const res = await patch(T_STUDIO.id, {
      remove: ['rates@council.ie'],
      restore: ['Rates@Council.IE'],
    })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ excluded_participants: ['rates@council.ie'] })
    expect(stored()).toEqual(['rates@council.ie'])
  })

  // A typo that reached the column would be a permanent exclusion matching
  // nobody — invisible, and undoable only by typing the same typo back.
  it('400s on an address it cannot use, writing nothing', async () => {
    const res = await patch(T_STUDIO.id, { remove: ['rates@council.ie', 'not an address'] })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('not an address')
    expect(writesTo(db)).toEqual([])
  })

  // The gate is loadTicketForUser, not a check in the handler: a per-route
  // hasPermission resolves at the CALLER'S active location, which is a
  // different question from the one a ticket route is asked. 404, never 403 —
  // a 403 after the row is read is an existence oracle.
  it('404s for a ticket at a location the caller has no access to, writing nothing', async () => {
    setupDb({ tickets: [{ ...T_STUDIO }, { ...T_OTHER_LOCATION }] })

    const res = await patch(T_OTHER_LOCATION.id, { remove: ['hatch@example.com'] })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(writesTo(db)).toEqual([])
  })

  // The branch nobody takes is the one that ships broken (the discarded-error
  // class). A failed write answered 200 would tell the operator the person is
  // off the thread while the next reply still mails them — the removal has to
  // fail loudly or not at all.
  it('500s when the write fails — never a 200 for a removal that did not land', async () => {
    failWrites(db, ['email_tickets'])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await patch(T_STUDIO.id, { remove: ['rates@council.ie'] })

    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('email_tickets write exploded')
    expect(stored()).toBeUndefined()
    errors.mockRestore()
  })
})
