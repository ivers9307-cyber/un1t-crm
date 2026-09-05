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

  // MAIL-SPAM.1 review — relatedness never crosses the quarantine flag. The
  // picker merges related → current, so a live anchor offering a quarantined
  // candidate would let a merge fold spam INTO a member's thread, and a spam
  // anchor offering the sender's live thread would fold that thread into the
  // spam ticket — where the 30-day purge deletes it. The nudge's open_count
  // follows the same scope, so "N other open conversations" never counts mail
  // the operator cannot see from where they are standing.
  it('a LIVE anchor never lists or counts the sender’s quarantined threads', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related(),
      related({ id: 'dddddddd-0000-4000-8000-000000000005', is_spam: true, spam_flagged_at: '2026-08-28T10:00:00Z' }),
    ] }))
    const { body } = await call()
    expect(body.data.related.map(r => r.id)).toEqual(['dddddddd-0000-4000-8000-000000000001'])
    expect(body.data.open_count).toBe(1)
  })

  it('a QUARANTINED anchor lists only the sender’s other quarantined threads, never a live one', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO, is_spam: true, spam_flagged_at: '2026-08-28T10:00:00Z' },
      related(),
      related({ id: 'dddddddd-0000-4000-8000-000000000005', is_spam: true, spam_flagged_at: '2026-08-28T10:00:00Z' }),
    ] }))
    const { body } = await call()
    expect(body.data.related.map(r => r.id)).toEqual(['dddddddd-0000-4000-8000-000000000005'])
    expect(body.data.open_count).toBe(1)
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

// ── MAIL-ARCH.3 — every candidate carries the SERVER'S `archived` stamp ───
//
// mobile/lib/mail-relate.js re-derived archived from `status` because this
// route stamped nothing, and read legacy `solved` as archived — while the web
// mail-relate.js reads live as `!== 'closed'`, so the two apps labelled the
// same related row differently. The candidates now go through the same
// stampMailRow as every list row, and both clients read the stamp.
describe('GET …/related — candidates are stamped through stampMailRow (MAIL-ARCH.3)', () => {
  it('stamps archived + needs_reply on every row: open → live, closed → archived, solved → LIVE', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related(),
      related({ id: 'dddddddd-0000-4000-8000-000000000002', status: 'closed', last_message_at: '2026-08-12T10:00:00Z' }),
      related({ id: 'dddddddd-0000-4000-8000-000000000003', status: 'solved', last_message_at: '2026-08-11T10:00:00Z' }),
    ] }))
    const { body } = await call()
    const byId = Object.fromEntries(body.data.related.map(r => [r.id, r]))
    expect(byId['dddddddd-0000-4000-8000-000000000001'].archived).toBe(false)
    expect(byId['dddddddd-0000-4000-8000-000000000002'].archived).toBe(true)
    // 🔴 the twin of the swipe-reopen row: solved is LIVE on the wire.
    expect(byId['dddddddd-0000-4000-8000-000000000003'].archived).toBe(false)
    // needs_reply is stamped too — from the row's own last_message_direction
    // (T_STUDIO's is inbound), not defaulted.
    expect(byId['dddddddd-0000-4000-8000-000000000001'].needs_reply).toBe(true)
    expect(byId['dddddddd-0000-4000-8000-000000000002'].needs_reply).toBe(false)
    expect(byId['dddddddd-0000-4000-8000-000000000003'].needs_reply).toBe(false)
  })

  it('needs_reply is TRUTHFUL: an open row whose last message was ours is not waiting', async () => {
    setupDb(mailState({ tickets: [
      { ...T_STUDIO },
      related({ last_message_direction: 'outbound' }),
    ] }))
    const { body } = await call()
    expect(body.data.related[0].needs_reply).toBe(false)
    expect(body.data.related[0].archived).toBe(false)
  })

  it('ASKS for last_message_direction — the fake does not project, so the stamp above would lie without this', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }, related()] }))
    await call()
    const listRead = db.selects.find(s => s.table === 'email_tickets' && String(s.columns).includes('subject'))
    expect(listRead).toBeTruthy()
    expect(String(listRead.columns)).toContain('last_message_direction')
    expect(String(listRead.columns)).toContain('is_spam')
  })

  it('the wire shape is the contract plus the two stamps, nothing else leaks', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }, related()] }))
    const { body } = await call()
    expect(Object.keys(body.data.related[0]).sort()).toEqual([
      'archived', 'id', 'last_message_at', 'message_count', 'needs_reply', 'requester_name', 'status', 'subject',
    ])
  })
})
