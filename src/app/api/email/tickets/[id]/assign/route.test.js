// EMAIL-ASSIGN.1 — ownership for the shared queue (2026-08-08 audit, P1).
//
// assigned_to existed from mig 482 and the 'mine'/'unassigned' views were
// built on it, but NO code ever wrote it — 'mine' was permanently empty and
// two staff had no way to say who owns a ticket. The model copies the sibling
// issues feature's claim idiom: CLAIM is a conditional UPDATE (assigned_to IS
// NULL) so two simultaneous claims race safely in Postgres, not in JS;
// RELEASE is conditional on the current assignee; REASSIGN-to-anyone is
// elevated-only, and the TARGET must be able to SEE the ticket (a grant on
// its mailbox, owner at its location, or master) — assigning accounts@ mail
// to someone who cannot open it would strand the ticket in a queue nobody
// can work.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, updatesTo } from '../../_test-db'
import {
  LOC_A, T_STUDIO, T_ACCOUNTS,
  COACH, OWNER, MASTER, GRANT_STUDIO, baseState,
} from '../../_test-fixtures'

const TARGET_NO_ACCESS = '99999999-0000-4000-8000-000000000001'
const TARGET_OWNER = 'profile-second-owner'

function post(id, body) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/assign`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

let db
function setup(ticket = {}, extra = {}) {
  db = makeDb(baseState({
    grants: [GRANT_STUDIO],
    tickets: [{ ...T_STUDIO, ...ticket }],
    profiles: [
      { id: COACH.id, full_name: 'Casey Coach', role: 'staff' },
      { id: OWNER.id, full_name: 'Orla Owner', role: 'owner' },
      { id: TARGET_OWNER, full_name: 'Second Owner', role: 'owner' },
    ],
    profileLocations: [
      { profile_id: TARGET_OWNER, location_id: LOC_A, role: 'owner' },
    ],
    ...extra,
  }))
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  setup()
})

describe('POST …/assign — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id, { assignee: 'me' })).status).toBe(401)
  })

  it('404s (never 403s) a ticket on a mailbox the caller holds no grant for', async () => {
    expect((await post(T_ACCOUNTS.id, { assignee: 'me' })).status).toBe(404)
  })

  it('400s a body with no usable assignee', async () => {
    expect((await post(T_STUDIO.id, {})).status).toBe(400)
    expect((await post(T_STUDIO.id, { assignee: 42 })).status).toBe(400)
  })

  it('an unknown id is "cannot see", never a shape error — validity is proven by the visibility lookup', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post(T_STUDIO.id, { assignee: 'no-such-person' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('assignee_cannot_see')
  })
})

describe('claim (assignee: "me")', () => {
  it('claims an unassigned ticket, guarded by a conditional update — the race lives in Postgres', async () => {
    const res = await post(T_STUDIO.id, { assignee: 'me' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ticket.assigned_to).toBe(COACH.id)

    const [update] = updatesTo(db, 'email_tickets')
    expect(update.payload.assigned_to).toBe(COACH.id)
    // THE concurrency contract: only an unassigned row may be claimed.
    expect(update.filters).toContainEqual(['is', 'assigned_to', null])
  })

  it('is idempotent when the ticket is already mine — 200, nothing written', async () => {
    setup({ assigned_to: COACH.id })
    const res = await post(T_STUDIO.id, { assignee: 'me' })
    expect(res.status).toBe(200)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
  })

  it('409s when somebody else already holds it — taking over is an explicit elevated reassign, never a claim', async () => {
    setup({ assigned_to: OWNER.id })
    const res = await post(T_STUDIO.id, { assignee: 'me' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('already_assigned')
  })
})

describe('release (assignee: null)', () => {
  it('releases my own ticket, conditional on it still being mine', async () => {
    setup({ assigned_to: COACH.id })
    const res = await post(T_STUDIO.id, { assignee: null })
    expect(res.status).toBe(200)
    expect((await res.json()).data.ticket.assigned_to).toBeNull()
    const [update] = updatesTo(db, 'email_tickets')
    expect(update.filters).toContainEqual(['eq', 'assigned_to', COACH.id])
  })

  it('is idempotent on an unassigned ticket — 200, nothing written', async () => {
    const res = await post(T_STUDIO.id, { assignee: null })
    expect(res.status).toBe(200)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
  })

  it("403s a non-elevated caller releasing somebody else's ticket", async () => {
    setup({ assigned_to: OWNER.id })
    const res = await post(T_STUDIO.id, { assignee: null })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('not_yours')
  })

  it("lets an owner-at-location release anybody's ticket", async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setup({ assigned_to: COACH.id })
    expect((await post(T_STUDIO.id, { assignee: null })).status).toBe(200)
  })
})

describe('reassign (assignee: <profile id>)', () => {
  it('403s a non-elevated caller — reassigning over heads is an elevated act', async () => {
    const res = await post(T_STUDIO.id, { assignee: OWNER.id })
    expect(res.status).toBe(403)
  })

  it('lets an owner assign to a grant-holder on the ticket’s mailbox', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post(T_STUDIO.id, { assignee: COACH.id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ticket.assigned_to).toBe(COACH.id)
    expect(body.data.assignee_name).toBe('Casey Coach')
  })

  it('refuses a target who cannot SEE the ticket — no grant, not elevated', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post(T_STUDIO.id, { assignee: TARGET_NO_ACCESS })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('assignee_cannot_see')
  })

  it('accepts a target who is owner at the ticket’s location, grant or no grant', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post(T_STUDIO.id, { assignee: TARGET_OWNER })
    expect(res.status).toBe(200)
    expect((await res.json()).data.ticket.assigned_to).toBe(TARGET_OWNER)
  })

  it('lets master reassign anywhere', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post(T_STUDIO.id, { assignee: COACH.id })).status).toBe(200)
  })
})
