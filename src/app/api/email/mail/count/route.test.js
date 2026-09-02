// INBOX-SURFACE.C — the Mail surface's OWN nav badge, the mirror image of
// /api/email/tickets/count (see that route's own header for the fuller case
// against "the whole live queue" / "unread_count>0" / "unassigned" — the same
// reasoning applies here verbatim and is not restated per-test below).
//
// WHAT MAKES THIS BADGE DIFFERENT FROM THE TICKET ONE, and the two properties
// these tests exist to pin:
//
// 1. IT COUNTS THIS SURFACE'S MAILBOXES ONLY. A studio running the trial has
//    studio@ on Mail and accounts@ still on tickets — an unanswered accounts@
//    ticket is real work, but it is the OTHER badge's job to say so. A count
//    that leaked it here would send an operator to a mailbox this list
//    refuses to render, the read dot nobody trusts twice.
//
// 2. 🔴 NO ORPHAN WIDENING. The ticket badge's elevated path also counts
//    NULL-mailbox tickets (mailbox_id is ON DELETE SET NULL; mig 484 predates
//    the column) — that is correct THERE because an orphan has no surface to
//    read and 'tickets' is the schema's own default, so it is the ticket
//    surface's mail by definition. It is NOT this surface's mail by the same
//    argument, so this route's scope is a plain `.in('mailbox_id', ids)` —
//    exactly what the mail LIST route uses (route.js: no `.or(...is.null)`
//    branch) — never `scopeToVisibleMailboxes`'s elevated `.or()` branch,
//    which would silently re-admit orphans through the back door.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, selectsFrom } from '../../tickets/_test-db'
import {
  LOC_A, LOC_B, MB_MAIL, MB_TICKETS, MB_OTHER, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, OWNER, MASTER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION, mailState,
} from '../_test-fixtures'

const at = (user, locationId = LOC_A) => ({ ...user, activeLocation: { id: locationId } })

async function count() {
  const res = await GET()
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

// studio@ is on Mail and needs-reply; accounts@ is on tickets and ALSO
// needs-reply — the fixture that proves the surface narrowing, not merely the
// per-account grant, is doing the work: without it this would badge 2.
const NEEDS_REPLY_BOTH = [
  { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
  { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(at(COACH))
  setupDb(mailState({ tickets: NEEDS_REPLY_BOTH, grants: [GRANT_STUDIO] }))
})

describe('GET /api/email/mail/count — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await count()).res.status).toBe(401)
  })

  it('answers 0 rather than erroring for a session with no active location', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, activeLocation: null })
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })

  it('answers 0 rather than erroring without the email_inbox permission', async () => {
    getCurrentUser.mockResolvedValue(at(COACH_NO_INBOX))
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })

  it('resolves the permission AT the active location, not merely against it', async () => {
    getCurrentUser.mockResolvedValue(at(MULTI_LOCATION, LOC_B))
    setupDb(mailState({
      mailboxes: [MB_MAIL, MB_TICKETS, { ...MB_OTHER, surface: 'inbox' }],
      tickets: [{ ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' }],
      grants: [GRANT_MULTI_OTHER_LOCATION],
    }))
    expect((await count()).body.data.count).toBe(0)
  })
})

describe('GET /api/email/mail/count — scope (RETIRE-TICKETS.1: all visible mailboxes + elevated orphans)', () => {
  it('counts tickets on EVERY visible mailbox for an elevated caller', async () => {
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(mailState({ tickets: NEEDS_REPLY_BOTH, grants: [] }))
    expect((await count()).body.data.count).toBe(2)
  })

  it('counts only granted mailboxes for a coach', async () => {
    // GRANT_STUDIO covers studio@ only — accounts@ stays out of the badge for
    // the person who cannot open it.
    setupDb(mailState({ tickets: NEEDS_REPLY_BOTH, grants: [GRANT_STUDIO] }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('DOES count a NULL-mailbox conversation for an elevated caller — orphans live here now', async () => {
    // The ticket queue was the orphan's only home; RETIRE-TICKETS.1 deleted
    // it, so the badge (like the list) carries the elevated `.or` branch.
    const orphan = {
      ...T_STUDIO, id: 'aaaaaaa9-0000-4000-8000-000000000009',
      mailbox_id: null, status: 'open', last_message_direction: 'inbound',
    }
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(mailState({ tickets: [...NEEDS_REPLY_BOTH, orphan], grants: [] }))
    expect((await count()).body.data.count).toBe(3)
  })

  it('does NOT count an orphan for a granted, non-elevated coach', async () => {
    const orphan = {
      ...T_STUDIO, id: 'aaaaaaa9-0000-4000-8000-000000000009',
      mailbox_id: null, status: 'open', last_message_direction: 'inbound',
    }
    setupDb(mailState({ tickets: [...NEEDS_REPLY_BOTH, orphan], grants: [GRANT_STUDIO] }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('never counts another studio’s tickets', async () => {
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(mailState({
      tickets: [...NEEDS_REPLY_BOTH, { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' }],
      grants: [],
    }))
    expect((await count()).body.data.count).toBe(2)
  })

  it('answers 0 — not an error — when the caller genuinely has no grants', async () => {
    setupDb(mailState({ tickets: NEEDS_REPLY_BOTH, grants: [] }))
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })
})

describe('GET /api/email/mail/count — WHAT the number counts', () => {
  const onMail = (over) => ({ ...T_STUDIO, mailbox_id: MB_MAIL.id, ...over })

  it('counts an open conversation whose last message came from THEM', async () => {
    setupDb(mailState({
      tickets: [onMail({ status: 'open', last_message_direction: 'inbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('does NOT count `pending` — we already replied', async () => {
    setupDb(mailState({
      tickets: [onMail({ status: 'pending', last_message_direction: 'outbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })

  it('does NOT count a conversation WE started', async () => {
    setupDb(mailState({
      tickets: [onMail({ status: 'open', last_message_direction: 'outbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })

  it('does NOT count solved or closed (archived)', async () => {
    setupDb(mailState({
      tickets: [
        onMail({ id: 's-1', status: 'solved', last_message_direction: 'inbound' }),
        onMail({ id: 'c-1', status: 'closed', last_message_direction: 'inbound' }),
      ],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })
})

describe('GET /api/email/mail/count — merged tombstones', () => {
  it('does not count a tombstone whose status write did not land', async () => {
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        {
          ...T_STUDIO, id: 'aaaaaaa8-0000-4000-8000-000000000008',
          status: 'open', last_message_direction: 'inbound', merged_into_id: T_STUDIO.id,
        },
      ],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })
})

describe('GET /api/email/mail/count — cheapness and failure', () => {
  it('asks for a COUNT ONLY — never the rows', async () => {
    await count()
    const ticketRead = selectsFrom(db, 'email_tickets').at(-1)
    expect(ticketRead.options).toEqual({ count: 'exact', head: true })
  })

  it('500s when the mailbox visibility lookup fails — it must NOT badge 0', async () => {
    setupDb(mailState({
      tickets: NEEDS_REPLY_BOTH,
      grants: [GRANT_STUDIO],
      errors: { email_mailbox_access: { code: '42501', message: 'permission denied' } },
    }))
    const { res, body } = await count()
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('500s when the count query itself fails — it must NOT badge 0', async () => {
    setupDb(mailState({
      tickets: NEEDS_REPLY_BOTH,
      grants: [GRANT_STUDIO],
      errors: { email_tickets: { code: '42703', message: 'column does not exist' } },
    }))
    expect((await count()).res.status).toBe(500)
  })
})

// MAIL-TRIAL.B — "each badge counts exactly the rows its own queue lists".
// The list route's own needs_reply view is the same predicate over the same
// scope, so the two must agree exactly — proven directly rather than trusted.
describe('GET /api/email/mail/count — agrees with the list it badges', () => {
  it('matches the mail list route’s needs_reply view exactly', async () => {
    const { GET: LIST } = await import('../route')
    const world = [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_STUDIO, id: 'extra-1', status: 'open', last_message_direction: 'outbound' },
      { ...T_STUDIO, id: 'extra-2', status: 'pending', last_message_direction: 'outbound' },
      { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
    ]

    setupDb(mailState({ tickets: world, grants: [GRANT_STUDIO] }))
    const badge = (await count()).body.data.count

    setupDb(mailState({ tickets: world, grants: [GRANT_STUDIO] }))
    const listed = await LIST(new Request(`http://x/api/email/mail?location_id=${LOC_A}&view=needs_reply`))
    const rows = (await listed.json()).data.conversations

    expect(badge).toBe(rows.length)
    expect(badge).toBe(1)
  })
})

// ── MAIL-BADGE.1 — ?scope=all: the estate sum for the sidebar badge ─────
describe('GET /api/email/mail/count?scope=all', () => {
  const req = () => new Request('http://x/api/email/mail/count?scope=all')

  it('sums needs-reply across every location the caller may read', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    setupDb(mailState({ tickets: [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' },
    ] }))
    const res = await GET(req())
    expect((await res.json()).data.count).toBe(2)
  })

  it('a location the caller lacks the key at contributes nothing', async () => {
    getCurrentUser.mockResolvedValue(MULTI_LOCATION) // staff at LOC_B: no email_inbox
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' },
      ],
      grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION],
    }))
    const res = await GET(req())
    expect((await res.json()).data.count).toBe(1)
  })

  it('🔴 one unanswerable studio refuses the whole sum — never a confidently smaller number', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    setupDb(mailState({ errors: { email_mailboxes: { code: '08006', message: 'reset' } } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
  })

  it('answers 0 for a caller with no eligible location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    setupDb(mailState())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.count).toBe(0)
  })
})

  it('🔴 refuses when only ONE studio is unanswerable — a partial sum is the lie', async () => {
    // Audit F2 — the all-fail case above cannot kill a some→every mutant.
    getCurrentUser.mockResolvedValue(MASTER)
    const db = setupDb(mailState({ tickets: [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' },
    ] }))
    // Fail ONLY LOC_B's ticket count; LOC_A answers normally.
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table === 'email_tickets') {
        const failure = { data: null, count: null, error: { code: '08006', message: 'reset' } }
        const origThen = b.then
        b.then = (res, rej) => {
          if (b._filters?.some(f => f[0] === 'eq' && f[1] === 'location_id' && f[2] === LOC_B)) {
            return Promise.resolve(failure).then(res, rej)
          }
          return origThen(res, rej)
        }
      }
      return b
    }
    const res = await GET(new Request('http://x/api/email/mail/count?scope=all'))
    expect(res.status).toBe(500)
  })
