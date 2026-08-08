// EMAIL-ASSIGN.1 — who can this ticket be assigned TO? Feeds the elevated
// reassign picker: grant-holders on the ticket's mailbox plus owners at its
// location, named. Elevated-only — a non-elevated caller has no reassign
// control, and this list enumerates colleagues' access.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb } from '../../_test-db'
import { LOC_A, T_STUDIO, COACH, OWNER, GRANT_STUDIO, baseState } from '../../_test-fixtures'

function get(id) {
  return GET(new Request(`http://x/api/email/tickets/${id}/assignees`), { params: Promise.resolve({ id }) })
}

let db
function setup(extra = {}) {
  db = makeDb(baseState({
    grants: [GRANT_STUDIO],
    profiles: [
      { id: COACH.id, full_name: 'Casey Coach', role: 'staff' },
      { id: OWNER.id, full_name: 'Orla Owner', role: 'owner' },
    ],
    profileLocations: [
      { profile_id: OWNER.id, location_id: LOC_A, role: 'owner' },
      { profile_id: COACH.id, location_id: LOC_A, role: 'staff' },
    ],
    ...extra,
  }))
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
  setup()
})

describe('GET …/assignees', () => {
  it('403s a non-elevated caller — the list enumerates colleagues’ access', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    expect((await get(T_STUDIO.id)).status).toBe(403)
  })

  it('returns grant-holders and owners, named, deduplicated', async () => {
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    const { assignees } = (await res.json()).data
    const ids = assignees.map(a => a.id).sort()
    expect(ids).toEqual([COACH.id, OWNER.id].sort())
    expect(assignees.find(a => a.id === COACH.id).full_name).toBe('Casey Coach')
  })

  it('a NULL-mailbox ticket offers owners only — nobody else can see it', async () => {
    setup({ tickets: [{ ...T_STUDIO, mailbox_id: null }] })
    const res = await get(T_STUDIO.id)
    const { assignees } = (await res.json()).data
    expect(assignees.map(a => a.id)).toEqual([OWNER.id])
  })
})
