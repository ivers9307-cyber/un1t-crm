// Resolve/acknowledge route for webhook_dead_letter rows (DEADLETTER-UI.1).
//
// The property that matters: this is the ONLY write the route performs —
// status + resolved_at. No replay, no processing. Most email-family rows are
// deliberately non-replayable (a replay of a sent email IS the double-send),
// so a human acknowledgement must exist and must stamp resolved_at, which is
// what the integration-health backlog count keys on.
//
// MAIL-DEADLETTER.1 review fix — visibility is judged AT THE ROW'S LOCATION,
// the same way the replay route does it (shared helper): master, or owner at
// the row's location (hasRoleAtLocation — never `user.role`, the caller's
// active-studio role, which let an owner of org B resolve org A's rows by
// enumerating the bigserial id). A row the caller cannot see answers 404, not
// 403. A NULL-location inbound row follows where its recipient routes TODAY.
//
// @/lib/auth is the REAL module with only getCurrentUser mocked, so
// hasRoleAtLocation's actual contract is what runs here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let rowResult = { data: null, error: null }
let updateResult = { error: null }
let updates = []

function makeBuilder() {
  const b = { _filters: [] }
  b.select = () => b
  b.eq = (col, val) => { b._filters.push([col, val]); return b }
  b.single = () => Promise.resolve(rowResult)
  b.update = (payload) => {
    const u = {
      eq: (col, val) => {
        updates.push({ payload, id: val })
        return Promise.resolve(updateResult)
      },
    }
    return u
  }
  return b
}
const fakeDb = { from: vi.fn(() => makeBuilder()) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/app/api/webhooks/postmark-inbound/[token]/route', () => ({
  replayInboundDeadLetter: vi.fn(),
  bestEffortInboundLocation: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { bestEffortInboundLocation } from '@/app/api/webhooks/postmark-inbound/[token]/route'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

// `role` is the ACTIVE-location value the OLD gate trusted — kept on every
// fixture so a regression back to `user.role` is visible: OWNER_B has role
// 'owner' and must still be refused on a studio-A row.
const MASTER = { id: 'prof-1', role: 'staff', profileRole: 'master', isMaster: true, rolesByLocation: {} }
const OWNER_A = { id: 'prof-2', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_A]: 'owner' } }
const OWNER_B = { id: 'prof-4', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_B]: 'owner' } }
const MANAGER_A = { id: 'prof-3', role: 'manager', profileRole: 'manager', isMaster: false, rolesByLocation: { [LOC_A]: 'manager' } }

const PAYLOAD = { MessageID: 'pm-1', From: 'member@example.com', ToFull: [{ Email: 'accounts@example.com' }] }

function row(overrides = {}) {
  return { id: 7, status: 'pending', provider: 'postmark_inbound', payload: PAYLOAD, location_id: LOC_A, ...overrides }
}

function req(body) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  rowResult = { data: row(), error: null }
  updateResult = { error: null }
  getCurrentUser.mockResolvedValue(MASTER)
  bestEffortInboundLocation.mockResolvedValue(null)
})

describe('POST /api/admin/webhook-dead-letter/[id]/resolve', () => {
  it('marks a pending row resolved and stamps resolved_at', async () => {
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 7, status: 'resolved' } })
    expect(updates).toHaveLength(1)
    expect(updates[0].payload.status).toBe('resolved')
    // resolved_at is what the integration-health count keys on — a row
    // acknowledged without it would keep nagging forever.
    expect(typeof updates[0].payload.resolved_at).toBe('string')
    expect(Object.keys(updates[0].payload).sort()).toEqual(['resolved_at', 'status'])
  })

  it('discard also stamps resolved_at (same effect on the health count)', async () => {
    const res = await POST(req({ status: 'discarded' }), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(updates[0].payload.status).toBe('discarded')
    expect(typeof updates[0].payload.resolved_at).toBe('string')
  })

  it('defaults to resolved when the body is empty or absent', async () => {
    const res = await POST(req(undefined), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(updates[0].payload.status).toBe('resolved')
  })

  it('acknowledges failed rows too (replay gave up; a human still must)', async () => {
    rowResult = { data: row({ status: 'failed' }), error: null }
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(200)
  })

  it('rejects any other target status — no path back to pending, no processing', async () => {
    const res = await POST(req({ status: 'pending' }), { params: { id: '7' } })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('409s an already-terminal row instead of double-stamping it', async () => {
    rowResult = { data: row({ status: 'resolved' }), error: null }
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('404s a missing row', async () => {
    rowResult = { data: null, error: { message: 'not found' } }
    const res = await POST(req({}), { params: { id: '999' } })
    expect(res.status).toBe(404)
  })

  it('reads the id off a PROMISE params — what Next 16 actually hands a route handler', async () => {
    // MAIL-DEADLETTER.1 — `const { id } = params` on a Promise is undefined,
    // so every Resolve/Discard click 400'd "Missing id" in production while
    // this file, passing a plain object, stayed green. Both shapes must work.
    const res = await POST(req({}), { params: Promise.resolve({ id: '7' }) })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('7')
  })

  it('anonymous is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({}), { params: { id: '7' } })).status).toBe(401)
    expect(updates).toHaveLength(0)
  })
})

describe('visibility: master, or owner AT THE ROW\'S LOCATION — 404 otherwise, never 403', () => {
  it('owner at the row\'s location may resolve', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
  })

  it('owner of ANOTHER location gets 404 and nothing is written (the old `user.role` gate let this through)', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(404)
    expect(updates).toHaveLength(0)
  })

  it('a manager at the row\'s location gets 404 — a detail route offers no 403 to enumerate against', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(404)
    expect(updates).toHaveLength(0)
  })

  it('visibility is judged BEFORE the row-state answer — a 409 for an invisible row would confirm the id exists', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    rowResult = { data: row({ status: 'resolved' }), error: null }
    expect((await POST(req({}), { params: { id: '7' } })).status).toBe(404)
  })

  describe('a row with NO location_id (no_matching_mailbox rows are stamped NULL by design)', () => {
    beforeEach(() => { rowResult = { data: row({ location_id: null }), error: null } })

    it('master may always resolve it', async () => {
      expect((await POST(req({}), { params: { id: '7' } })).status).toBe(200)
    })

    it('an owner may resolve it once the payload\'s recipient resolves to a mailbox at THEIR location', async () => {
      getCurrentUser.mockResolvedValue(OWNER_A)
      bestEffortInboundLocation.mockResolvedValue(LOC_A)
      const res = await POST(req({}), { params: { id: '7' } })
      expect(res.status).toBe(200)
      expect(bestEffortInboundLocation).toHaveBeenCalledWith(fakeDb, PAYLOAD)
    })

    it('…and 404 when it resolves to someone else\'s location, or to nothing', async () => {
      getCurrentUser.mockResolvedValue(OWNER_A)
      bestEffortInboundLocation.mockResolvedValue(LOC_B)
      expect((await POST(req({}), { params: { id: '7' } })).status).toBe(404)
      bestEffortInboundLocation.mockResolvedValue(null)
      expect((await POST(req({}), { params: { id: '7' } })).status).toBe(404)
      expect(updates).toHaveLength(0)
    })

    it('a NULL-location row of a non-email provider is master-only (no recipient to route by)', async () => {
      getCurrentUser.mockResolvedValue(OWNER_A)
      rowResult = { data: row({ location_id: null, provider: 'zoom_contact_sync', payload: {} }), error: null }
      expect((await POST(req({}), { params: { id: '7' } })).status).toBe(404)
      expect(bestEffortInboundLocation).not.toHaveBeenCalled()
    })
  })
})
