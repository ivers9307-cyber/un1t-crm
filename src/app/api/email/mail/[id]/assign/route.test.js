// INBOXASSIGN.1 — POST/GET /api/email/mail/[id]/assign, through the REAL
// Mail gate (loadConversationForUser: studio membership, `email_inbox` at the
// conversation's studio, sight of its mailbox — every refusal a 404) over an
// in-memory database that applies the filters it is given.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  memoryDb, staffWorld, LOC_A, LOC_B, MAILBOX_A, ME, ALEX, CASEY, DREW, MORGAN, OWNER,
} from '@/lib/inbox-assignment.test-helpers'

const T_A = 'ffffffff-0000-4000-8000-00000000000a'
const T_B = 'ffffffff-0000-4000-8000-00000000000b'
const T_MERGED = 'ffffffff-0000-4000-8000-00000000000c'
const MAILBOX_B = 'cccccccc-0000-4000-8000-0000000000bb'

// MORGAN works studio A's mail: email_inbox by override + a grant on its mailbox.
const MORGAN_USER = {
  id: MORGAN, role: 'head_coach', profileRole: 'head_coach',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'head_coach' },
  assignmentsByLocation: { [LOC_A]: { role: 'head_coach', permissions: { email_inbox: true } } },
}
// A manager at A with email_inbox but NO grant on the mailbox: cannot see it.
const ME_USER = {
  id: ME, role: 'manager', profileRole: 'manager',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  assignmentsByLocation: { [LOC_A]: { role: 'manager', permissions: {} } },
}

let db
function setup(opts) {
  db = memoryDb(staffWorld({
    email_mailboxes: [
      { id: MAILBOX_A, location_id: LOC_A, address: 'desk@example.com', label: 'Desk', is_default: true, active: true, egress: null },
      { id: MAILBOX_B, location_id: LOC_B, address: 'other@example.com', label: 'Other', is_default: true, active: true, egress: null },
    ],
    email_tickets: [
      { id: T_A, location_id: LOC_A, mailbox_id: MAILBOX_A, assigned_to: null, merged_into_id: null },
      { id: T_B, location_id: LOC_B, mailbox_id: MAILBOX_B, assigned_to: null, merged_into_id: null },
      { id: T_MERGED, location_id: LOC_A, mailbox_id: MAILBOX_A, assigned_to: null, merged_into_id: T_A },
    ],
  }), opts)
  createServerClient.mockReturnValue(db)
}
const post = (id, body) => POST(
  new Request('http://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
)
const get = (id) => GET(new Request('http://x/api'), { params: Promise.resolve({ id }) })
const wrote = () => db.calls.some(c => c.op === 'update')
const owner = (id) => db.state.email_tickets.find(t => t.id === id).assigned_to

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MORGAN_USER)
  setup()
})

describe('POST /api/email/mail/[id]/assign', () => {
  it('401 when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_A, { assignee: 'me' })).status).toBe(401)
  })

  it('assigns to me', async () => {
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assigned_to: MORGAN, assignee_name: 'Morgan Example' })
    expect(owner(T_A)).toBe(MORGAN)
  })

  it('another studio\'s conversation is a 404 and nothing is written', async () => {
    expect((await post(T_B, { assignee: 'me' })).status).toBe(404)
    expect(wrote()).toBe(false)
  })

  it('a caller who cannot see the mailbox gets a 404', async () => {
    getCurrentUser.mockResolvedValue(ME_USER)
    expect((await post(T_A, { assignee: 'me' })).status).toBe(404)
    expect(wrote()).toBe(false)
  })

  it('names a colleague who can see the mailbox; refuses one without email, at another studio, or deleted', async () => {
    expect((await post(T_A, { assignee: OWNER })).status).toBe(200)
    expect(owner(T_A)).toBe(OWNER)
    for (const who of [ALEX, CASEY, DREW, ME]) {
      const res = await post(T_A, { assignee: who })
      expect(res.status).toBe(400)
    }
    expect(owner(T_A)).toBe(OWNER)
  })

  it('unassigns', async () => {
    db.state.email_tickets[0].assigned_to = OWNER
    expect((await post(T_A, { assignee: null })).status).toBe(200)
    expect(owner(T_A)).toBe(null)
  })

  it('a merged-away conversation takes no owner', async () => {
    expect((await post(T_MERGED, { assignee: 'me' })).status).toBe(409)
    expect(wrote()).toBe(false)
  })

  it('a failed or zero-row write is not a success', async () => {
    setup({ fail: { 'email_tickets:update': { message: 'boom' } } })
    expect((await post(T_A, { assignee: 'me' })).status).toBe(500)
    setup({ zeroRowUpdate: ['email_tickets'] })
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(409)
    expect((await res.json()).success).toBe(false)
  })
})

describe('GET /api/email/mail/[id]/assign', () => {
  it('lists names only of those who can see the mailbox', async () => {
    const res = await get(T_A)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.staff.map(s => s.id).sort()).toEqual([MORGAN, OWNER].sort())
    for (const s of data.staff) expect(Object.keys(s).sort()).toEqual(['full_name', 'id'])
  })
  it('404 for another studio', async () => {
    expect((await get(T_B)).status).toBe(404)
  })
  it('401 when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(T_A)).status).toBe(401)
  })
  it('404 for a caller who cannot see the mailbox', async () => {
    getCurrentUser.mockResolvedValue(ME_USER)
    expect((await get(T_A)).status).toBe(404)
  })
})
