// MAIL-REFINE.1 — related conversations: other threads from the SAME sender,
// visible under the caller's exact mailbox scope. The nudge and the merge
// picker are both fed from here, so the properties pinned are access (never
// wider than the scoped list), honesty (a failed lookup is an error, never an
// empty list), and the open-count the nudge renders.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb } from '../../../tickets/_test-db'
import {
  LOC_A, T_STUDIO, T_ACCOUNTS, MASTER, COACH, GRANT_STUDIO, mailState,
} from '../../_test-fixtures'

const SAME_SENDER = T_STUDIO.requester_email

const related = (over = {}) => ({
  ...T_STUDIO,
  id: 'dddddddd-0000-4000-8000-000000000001',
  subject: 'RE: Meter reading — urgent',
  status: 'open',
  last_message_at: '2026-08-28T10:00:00Z',
  ...over,
})

async function call(id = T_STUDIO.id) {
  const res = await GET(
    new Request(`http://x/api/email/mail/${id}/related`),
    { params: Promise.resolve({ id }) },
  )
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('GET /api/email/mail/[id]/related', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    setupDb(mailState())
    expect((await call()).res.status).toBe(401)
  })

  it('404s a ticket the caller cannot see', async () => {
    setupDb(mailState())
    expect((await call('eeeeeeee-0000-4000-8000-000000000009')).res.status).toBe(404)
  })

  it('lists other threads from the same sender, newest first, self excluded', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related(),
      related({ id: 'dddddddd-0000-4000-8000-000000000002', subject: 'Flogas account setup', status: 'closed', last_message_at: '2026-08-12T10:00:00Z' }),
    ] }))
    const { res, body } = await call()
    expect(res.status).toBe(200)
    const ids = body.data.related.map(r => r.id)
    expect(ids).toEqual([
      'dddddddd-0000-4000-8000-000000000001',
      'dddddddd-0000-4000-8000-000000000002',
    ])
    expect(body.data.open_count).toBe(1)
  })

  it('matches the sender case-insensitively but never as a pattern', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related({ requester_email: SAME_SENDER.toUpperCase() }),
      // an ilike wildcard row must NOT match (the escapeLikePattern rule)
      related({ id: 'dddddddd-0000-4000-8000-000000000003', requester_email: 'x%@example.com' }),
    ] }))
    const { body } = await call()
    expect(body.data.related.map(r => r.id)).toEqual(['dddddddd-0000-4000-8000-000000000001'])
  })

  it('a wildcard in the ANCHOR sender stays a literal', async () => {
    // The stored address can itself hold LIKE metacharacters; unescaped it
    // would relate a_b@ to axb@ — a stranger's thread in the merge picker.
    setupDb(mailState({ tickets: [
      { ...T_STUDIO, requester_email: 'a_b@example.com' },
      related({ requester_email: 'axb@example.com' }),
    ] }))
    const { body } = await call()
    expect(body.data.related).toEqual([])
  })

  it('caps the picker list while open_count stays true', async () => {
    const many = Array.from({ length: 12 }, (_, i) => related({
      id: `dddddddd-0000-4000-8000-0000000000${String(10 + i)}`,
      last_message_at: `2026-08-${String(10 + i)}T10:00:00Z`,
    }))
    setupDb(mailState({ tickets: [{ ...T_STUDIO }, ...many] }))
    const { body } = await call()
    expect(body.data.related).toHaveLength(10)
    expect(body.data.open_count).toBe(12)
  })

  it('a different sender is not related', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related({ requester_email: 'someone.else@example.com' }),
    ] }))
    const { body } = await call()
    expect(body.data.related).toEqual([])
    expect(body.data.open_count).toBe(0)
  })

  it('a merged tombstone is not offered again', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related({ merged_into_id: T_STUDIO.id }),
    ] }))
    const { body } = await call()
    expect(body.data.related).toEqual([])
  })

  it('respects the caller’s mailbox grants — an invisible mailbox’s thread never appears', async () => {
    // COACH is granted studio@ only; a same-sender thread on accounts@ exists
    // but must not leak into the related list.
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO },
        related({ id: 'dddddddd-0000-4000-8000-000000000004', mailbox_id: T_ACCOUNTS.mailbox_id }),
      ],
      grants: [GRANT_STUDIO],
    }))
    const { body } = await call()
    expect(body.data.related).toEqual([])
  })

  it('a sender-less ticket has no relations, not an error', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, requester_email: null }] }))
    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body.data.related).toEqual([])
    expect(body.data.open_count).toBe(0)
  })

  it('a failed lookup is a 500, never an empty list', async () => {
    const state = mailState({ tickets: [{ ...T_STUDIO }, related()] })
    setupDb(state)
    // Fail every email_tickets read AFTER the detail load succeeded — the
    // wrapper pattern failWrites uses, aimed at reads instead.
    let ticketReads = 0
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table === 'email_tickets') {
        ticketReads += 1
        if (ticketReads > 1) {
          const failure = { data: null, error: { code: '08006', message: 'reset' } }
          b.then = (res, rej) => Promise.resolve(failure).then(res, rej)
          b.maybeSingle = () => Promise.resolve(failure)
        }
      }
      return b
    }
    const { res } = await call()
    expect(res.status).toBe(500)
  })
})
