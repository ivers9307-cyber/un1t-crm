// MAIL-DEADLETTER.1 — the operator replay route for webhook_dead_letter rows.
//
// Three properties, each of which shipped broken or absent before this task:
//
//   1. THE GUARD JUDGES THE ROW'S LOCATION, NOT THE CALLER'S ACTIVE ROLE.
//      The route used to gate on `user.role === 'owner'` — the role at
//      whichever studio the caller happened to have ACTIVE — so an owner of
//      studio B could replay (and resolve) a studio-A row. It is now master,
//      or owner AT THE ROW'S LOCATION (hasRoleAtLocation), and a row the
//      caller cannot see answers 404, not 403, so ids cannot be enumerated.
//      A row with no location is master-only unless the payload itself names
//      a mailbox (inbound email: the recipient address → mailbox → location).
//
//   2. A REPLAY THAT RECORDED NOTHING DOES NOT RESOLVE THE ROW. postmark_inbound
//      rows dead-letter on a 200 (no mailbox, no sender), so the pipeline can
//      run cleanly and still file nothing. Marking that "resolved" would be
//      exactly the invariant in CLAUDE.md: the dedupe key is claimed, the
//      provider's retry is gone, and a green tick would destroy the event.
//
//   3. `params` IS A PROMISE IN NEXT 16. The route read `params.id`
//      synchronously, which is `undefined` on a Promise, so every click 400'd
//      "Missing id" in production. The old test passed a plain object and
//      could not see it. Tests here hand the route a Promise.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so hasRoleAtLocation's actual contract is what runs here. The
// replay DRIVER (replayDeadLetter) is real too — resolve/not-resolve is the
// property under test — and only the inbound re-driver is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/app/api/webhooks/postmark-inbound/[token]/route', () => ({
  replayInboundDeadLetter: vi.fn(),
  bestEffortInboundLocation: vi.fn(),
}))
// The registry's inbody re-driver parses the payload first; keep it predictable.
vi.mock('@/lib/inbody-webhook', () => ({
  parseInbodyNotification: vi.fn((body) => ({
    account: body?.Account ?? null, telHp: null, userId: body?.UserID ?? null,
    testDatetime: body?.TestDatetimes ?? null, equip: null, equipSerial: null, isTempData: null,
  })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  replayInboundDeadLetter,
  bestEffortInboundLocation,
} from '@/app/api/webhooks/postmark-inbound/[token]/route'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

// `role` is the ACTIVE-location value the OLD gate trusted — kept on every
// fixture so a regression back to `user.role` is visible: OWNER_B has
// role 'owner' and must still be refused on a studio-A row.
const MASTER = { id: 'u-master', role: 'owner', profileRole: 'master', isMaster: true, rolesByLocation: {} }
const OWNER_A = { id: 'u-owner-a', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_A]: 'owner' } }
const OWNER_B = { id: 'u-owner-b', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_B]: 'owner' } }
const MANAGER_A = { id: 'u-mgr-a', role: 'manager', profileRole: 'manager', isMaster: false, rolesByLocation: { [LOC_A]: 'manager' } }

const PAYLOAD = { MessageID: 'pm-1', From: 'member@example.com', ToFull: [{ Email: 'accounts@hatchstreetfitness.com' }] }

function inboundRow(overrides = {}) {
  return {
    id: 7, provider: 'postmark_inbound', payload: PAYLOAD, status: 'pending',
    attempts: 1, location_id: LOC_A, last_attempt_at: null, ...overrides,
  }
}

// ── fake db ─────────────────────────────────────────────────────────────────
// webhook_dead_letter: select().eq('id').single() → rowResult; update(p).eq()
// is recorded. inbody_webhook_events: upsert recorded (the registry path).
let rowResult
let updates
let upserts

function makeDb() {
  const db = {}
  db.from = (table) => {
    const b = { _table: table }
    b.select = () => b
    b.eq = () => b
    b.single = () => Promise.resolve(table === 'webhook_dead_letter' ? rowResult : { data: null, error: null })
    b.maybeSingle = b.single
    b.update = (payload) => ({
      eq: (col, val) => {
        updates.push({ table, payload, id: val })
        return Promise.resolve({ error: null })
      },
    })
    b.upsert = (payload, opts) => {
      upserts.push({ table, payload, opts })
      return Promise.resolve({ error: null })
    }
    return b
  }
  return db
}

// Next 16 hands route handlers a PROMISE for params.
function call(id = '7', body = {}) {
  return POST(
    { json: async () => body },
    { params: Promise.resolve({ id }) },
  )
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  upserts = []
  rowResult = { data: inboundRow(), error: null }
  db = makeDb()
  createServerClient.mockImplementation(() => db)
  getCurrentUser.mockResolvedValue(MASTER)
  replayInboundDeadLetter.mockResolvedValue({ recorded: true, result: { ticket_id: 'T-1', mailbox_id: 'mb-1' } })
  bestEffortInboundLocation.mockResolvedValue(null)
})

const resolvedUpdates = () => updates.filter(u => u.payload.status === 'resolved')

describe('POST /api/admin/webhook-dead-letter/[id]/replay — inbound email', () => {
  it('re-runs the inbound pipeline on the stored payload and resolves the row when it filed something', async () => {
    const res = await call()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(replayInboundDeadLetter).toHaveBeenCalledTimes(1)
    expect(replayInboundDeadLetter.mock.calls[0][1]).toEqual(PAYLOAD)
    expect(json).toMatchObject({
      success: true, status: 'resolved', recorded: true, id: 7, provider: 'postmark_inbound',
      result: { ticket_id: 'T-1', mailbox_id: 'mb-1' },
    })
    // The row is resolved, attempts bumped, and the replay time stamped.
    expect(resolvedUpdates()).toHaveLength(1)
    const patch = resolvedUpdates()[0].payload
    expect(patch.attempts).toBe(2)
    expect(typeof patch.resolved_at).toBe('string')
    expect(typeof patch.last_attempt_at).toBe('string')
  })

  it('does NOT resolve a row whose replay ran but recorded nothing — the outcome lands on the row instead', async () => {
    replayInboundDeadLetter.mockResolvedValue({ recorded: false, reason: 'no_matching_mailbox' })

    const res = await call()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: false, recorded: false, reason: 'no_matching_mailbox', status: 'pending' })
    expect(resolvedUpdates()).toHaveLength(0)
    // …but the attempt IS recorded: attempts++, last_attempt_at, and the
    // reason in `error` so the morgue row says what the replay found.
    expect(updates).toHaveLength(1)
    const patch = updates[0].payload
    expect(patch.status).toBeUndefined()
    expect(patch.resolved_at).toBeUndefined()
    expect(patch.attempts).toBe(2)
    expect(typeof patch.last_attempt_at).toBe('string')
    expect(patch.error).toContain('no_matching_mailbox')
  })

  it('treats "already filed" as recorded — replaying a processed message is a no-op that resolves, not a duplicate', async () => {
    replayInboundDeadLetter.mockResolvedValue({ recorded: true, result: { already_filed: true } })
    const res = await call()
    const json = await res.json()
    expect(json).toMatchObject({ success: true, status: 'resolved', recorded: true, result: { already_filed: true } })
    expect(resolvedUpdates()).toHaveLength(1)
  })

  it('a pipeline failure (thrown) bumps attempts and keeps the row open with the error recorded', async () => {
    replayInboundDeadLetter.mockRejectedValue(new Error('contact_lookup_failed'))
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: false, status: 'pending', error: 'contact_lookup_failed' })
    expect(resolvedUpdates()).toHaveLength(0)
    expect(updates[0].payload.attempts).toBe(2)
    expect(updates[0].payload.error).toBe('contact_lookup_failed')
  })
})

describe('visibility: master, or owner AT THE ROW\'S LOCATION — 404 otherwise', () => {
  it('owner at the row\'s location may replay', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const res = await call()
    expect(res.status).toBe(200)
    expect(replayInboundDeadLetter).toHaveBeenCalledTimes(1)
  })

  it('owner of ANOTHER location gets 404 and nothing runs (the old `user.role` gate let this through)', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const res = await call()
    expect(res.status).toBe(404)
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('a member at the row\'s location WITHOUT the role gets 404 (detail route — no 403 to enumerate against)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await call()
    expect(res.status).toBe(404)
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('anonymous is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
  })

  describe('a row with NO location_id (no_matching_mailbox rows are stamped NULL by design)', () => {
    beforeEach(() => { rowResult = { data: inboundRow({ location_id: null }), error: null } })

    it('master may always replay it', async () => {
      const res = await call()
      expect(res.status).toBe(200)
      expect(replayInboundDeadLetter).toHaveBeenCalledTimes(1)
    })

    it('an owner may replay it once the payload\'s recipient resolves to a mailbox at THEIR location', async () => {
      // This is the primary replay use case: the operator configures the
      // missing mailbox, then replays. The row still says NULL; the payload
      // now routes. Visibility follows where the mail WOULD file.
      getCurrentUser.mockResolvedValue(OWNER_A)
      bestEffortInboundLocation.mockResolvedValue(LOC_A)
      const res = await call()
      expect(res.status).toBe(200)
      expect(bestEffortInboundLocation).toHaveBeenCalledWith(db, PAYLOAD)
    })

    it('…and 404 when it resolves to someone else\'s location, or to nothing', async () => {
      getCurrentUser.mockResolvedValue(OWNER_A)
      bestEffortInboundLocation.mockResolvedValue(LOC_B)
      expect((await call()).status).toBe(404)
      bestEffortInboundLocation.mockResolvedValue(null)
      expect((await call()).status).toBe(404)
      expect(replayInboundDeadLetter).not.toHaveBeenCalled()
    })
  })
})

describe('row state + provider gates', () => {
  it('409s an already-resolved row', async () => {
    rowResult = { data: inboundRow({ status: 'resolved' }), error: null }
    expect((await call()).status).toBe(409)
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
  })

  it('400s a discarded row', async () => {
    rowResult = { data: inboundRow({ status: 'discarded' }), error: null }
    expect((await call()).status).toBe(400)
  })

  it('replays a failed row (an earlier replay gave up; the operator may try again)', async () => {
    rowResult = { data: inboundRow({ status: 'failed' }), error: null }
    expect((await call()).status).toBe(200)
    expect(replayInboundDeadLetter).toHaveBeenCalledTimes(1)
  })

  it('404s a missing row', async () => {
    rowResult = { data: null, error: { message: 'not found' } }
    expect((await call('999')).status).toBe(404)
  })

  it('400s a provider with no re-driver (glofox — action replay is not idempotent)', async () => {
    rowResult = { data: inboundRow({ provider: 'glofox', payload: { any: 1 } }), error: null }
    const res = await call()
    expect(res.status).toBe(400)
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('a registry provider (inbody) still goes through the registry re-driver, and resolves on success', async () => {
    rowResult = {
      data: inboundRow({ provider: 'inbody', payload: { Account: 'acc', UserID: '9', TestDatetimes: '20240101120000' } }),
      error: null,
    }
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, status: 'resolved', provider: 'inbody' })
    expect(upserts).toHaveLength(1)
    expect(upserts[0].table).toBe('inbody_webhook_events')
    expect(replayInboundDeadLetter).not.toHaveBeenCalled()
    expect(resolvedUpdates()).toHaveLength(1)
  })

  it('reads the id off the awaited params (a plain object still works for callers that pass one)', async () => {
    const res = await POST({ json: async () => ({}) }, { params: { id: '7' } })
    expect(res.status).toBe(200)
  })
})
