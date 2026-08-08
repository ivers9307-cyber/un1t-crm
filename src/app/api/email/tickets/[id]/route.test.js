// EMAIL-TICKET.4 — the ticket detail route.
//
// The load-bearing assertion is 404 (never 403) for a ticket on a mailbox the
// caller cannot see: a 403 would confirm the id exists and let an authenticated
// coach enumerate the studio's billing tickets by id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, selectsFrom } from '../_test-db'
import {
  LOC_B, MB_STUDIO, MB_ACCOUNTS, T_STUDIO, T_ACCOUNTS,
  COACH, COACH_NO_INBOX, OWNER, GRANT_STUDIO, baseState,
} from '../_test-fixtures'

function get(id) {
  return GET(new Request(`http://x/api/email/tickets/${id}`), { params: Promise.resolve({ id }) })
}

const MESSAGES = [
  {
    id: 'm-2', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', text_body: 'We open at 6.', is_internal_note: false,
    created_at: '2026-08-06T09:30:00Z',
  },
  {
    id: 'm-1', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', text_body: 'What time is the 6am?', is_internal_note: false,
    created_at: '2026-08-06T09:00:00Z',
  },
  {
    id: 'm-other', ticket_id: T_ACCOUNTS.id, location_id: T_ACCOUNTS.location_id,
    direction: 'inbound', text_body: 'My DD bounced', is_internal_note: false,
    created_at: '2026-08-06T10:00:00Z',
  },
]

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  setupDb(baseState({ grants: [GRANT_STUDIO], messages: MESSAGES }))
})

describe('GET /api/email/tickets/[id]', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(T_STUDIO.id)).status).toBe(401)
  })

  // EMAIL-TICKET-CLEANUP.1 — 404, not the 403 this used to be. The gate moved
  // into loadTicketForUser so it can resolve at the TICKET'S location, which
  // means it now runs AFTER the row is read — and a 403 there would say "this
  // id exists, at a studio where you lack the key" while a bad id says 404.
  // Every other way to be refused on this surface is already indistinguishable;
  // a fourth reason has to be too.
  // The caller holds the studio@ GRANT and is assigned to the location. Only
  // the surface key is missing, so this is the one test that isolates it.
  it('404s without the email_inbox permission AT THE TICKET\u2019S location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await get(T_STUDIO.id)).status).toBe(404)
  })

  it('404s for a ticket on a mailbox the caller cannot see — NOT 403', async () => {
    const res = await get(T_ACCOUNTS.id)
    expect(res.status).toBe(404)
    // Byte-identical to a genuinely missing id: nothing distinguishes them.
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('404s for an id that does not exist', async () => {
    expect((await get('aaaaaaa9-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('404s for a ticket at another location', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO, id: 'foreign-1', location_id: LOC_B }],
    }))
    expect((await get('foreign-1')).status).toBe(404)
  })

  it('returns the ticket, its mailbox and the thread oldest-first', async () => {
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.ticket.id).toBe(T_STUDIO.id)
    expect(data.ticket.mailbox.address).toBe(MB_STUDIO.address)
    expect(data.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])
    // Another ticket's messages never bleed in.
    expect(data.messages.map(m => m.id)).not.toContain('m-other')
  })

  it('lets an elevated caller open a ticket on any active mailbox', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [], messages: MESSAGES }))
    const res = await get(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    expect((await res.json()).data.ticket.mailbox.address).toBe(MB_ACCOUNTS.address)
  })

  it('does not mark the ticket read as a side effect of reading it', async () => {
    await get(T_STUDIO.id)
    // Marking read is its own POST — a GET must not write.
    expect(db.updates).toHaveLength(0)
  })
})

// EMAIL-TICKET.6 — a failed query must not read as an empty thread.
//
// The messages select used to be destructured as `{ data: messagesDesc }` with
// `.error` never inspected and the result used as `messagesDesc || []`, so ANY
// failure returned HTTP 200 with a ticket and zero messages — on web and on
// mobile, nothing logged, nothing surfaced. That is also the landmine under the
// email_conversations retirement: MESSAGE_COLUMNS named `conversation_id`, so
// dropping the column would have turned every ticket in the estate into a
// silently empty thread rather than an outage anybody could see.
describe('GET /api/email/tickets/[id] — query failures are loud', () => {
  it('500s when the messages query errors — never 200 with an empty thread', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: MESSAGES,
      errors: { email_inbox_messages: { code: '42703', message: 'column email_inbox_messages.conversation_id does not exist' } },
    }))
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    // The reason travels — a 500 saying nothing is only marginally better
    // than a 200 saying nothing.
    expect(body.error).toContain('conversation_id')
  })

  it('500s when the contact lookup errors', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: MESSAGES,
      errors: { contacts: { code: '42P01', message: 'relation "contacts" does not exist' } },
    }))
    expect((await get(T_STUDIO.id)).status).toBe(500)
  })

  it('still returns a healthy thread normally', async () => {
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    expect((await res.json()).data.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])
  })

  it('does not ASK for conversation_id — email_conversations is being retired', async () => {
    // Nothing in the response shape reads it, so naming it in the select only
    // buys a dependency on a column scheduled to disappear.
    await get(T_STUDIO.id)
    const thread = selectsFrom(db, 'email_inbox_messages')
    expect(thread).toHaveLength(1)
    expect(thread[0].columns).not.toContain('conversation_id')
    // …while still asking for the columns the thread genuinely renders.
    expect(thread[0].columns).toContain('text_body')
    expect(thread[0].columns).toContain('html_body')
  })
})

// EMAIL-DELIVERY.1 — the thread cannot show a bounce it never fetched.
//
// This is the cheap half of the feature and the easy half to break: the
// stamper can be writing delivery_status perfectly while the GET quietly omits
// it from MESSAGE_COLUMNS, and every bounced reply then renders as an ordinary
// one — the exact failure this ticket exists to fix, restored by omission.
describe('GET /api/email/tickets/[id] — delivery status reaches the thread', () => {
  beforeEach(() => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [
        {
          id: 'm-bounced', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
          direction: 'outbound', text_body: 'We open at 6.', is_internal_note: false,
          created_at: '2026-08-06T09:30:00Z',
          delivery_status: 'bounced',
          delivery_status_at: '2026-08-06T09:31:00Z',
          delivery_detail: 'smtp;550 5.1.1 User unknown',
          delivery_bounce_type: 'hard',
        },
      ],
    }))
  })

  it('asks for all four delivery columns', async () => {
    await get(T_STUDIO.id)
    const [thread] = selectsFrom(db, 'email_inbox_messages')
    for (const col of ['delivery_status', 'delivery_status_at', 'delivery_detail', 'delivery_bounce_type']) {
      expect(thread.columns).toContain(col)
    }
  })

  it('passes them through to the client untouched', async () => {
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    const [msg] = (await res.json()).data.messages
    expect(msg).toMatchObject({
      delivery_status: 'bounced',
      delivery_bounce_type: 'hard',
      delivery_detail: 'smtp;550 5.1.1 User unknown',
      delivery_status_at: '2026-08-06T09:31:00Z',
    })
  })
})

// ── EMAIL-CC.1 — recipients on the thread, and who a reply would reach ──
//
// TWO SEPARATE CLAIMS, and conflating them is the whole risk of this route.
//   1. bcc_emails IS returned. The only caller is a staff member who already
//      passed the ticket gate, and a colleague who cannot see whether
//      accounts@ was blind-copied on a refund reply is working blind.
//   2. bcc_emails is STILL never a recipient. reply_recipients is derived from
//      From/To/Cc only, so the set this route hands the composer is the set
//      the reply route will send to — computed by the same functions, so the
//      two cannot disagree.
describe('GET …/[id] — recipients (EMAIL-CC.1)', () => {
  const CC_INBOUND = {
    id: 'm-cc', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', is_internal_note: false, text_body: 'Question',
    from_email: 'member@example.com',
    to_email: MB_STUDIO.address, to_emails: [MB_STUDIO.address],
    cc_emails: ['colleague@example.com'], bcc_emails: [],
    created_at: '2026-08-06T09:00:00Z',
  }
  const OUTBOUND_WITH_BCC = {
    id: 'm-bcc', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', is_internal_note: false, text_body: 'Answered',
    from_email: 'hello@un1t.ie',
    to_email: 'member@example.com', to_emails: ['member@example.com'],
    cc_emails: ['colleague@example.com'], bcc_emails: ['secret@example.com'],
    created_at: '2026-08-06T10:00:00Z',
  }

  beforeEach(() => {
    process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
  })

  it('asks for the three recipient columns', async () => {
    await get(T_STUDIO.id)
    const [thread] = selectsFrom(db, 'email_inbox_messages')
    for (const col of ['to_emails', 'cc_emails', 'bcc_emails']) {
      expect(thread.columns).toContain(col)
    }
  })

  it('returns the member’s Cc so the thread can show who is on it', async () => {
    const res = await get(T_STUDIO.id)
    const [msg] = (await res.json()).data.messages
    expect(msg.cc_emails).toEqual(['colleague@example.com'])
  })

  // Claim 1: staff on the ticket see their own blind-copy list.
  it('returns bcc_emails to the staff member on the ticket', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [OUTBOUND_WITH_BCC] }))
    const res = await get(T_STUDIO.id)
    const [msg] = (await res.json()).data.messages
    expect(msg.bcc_emails).toEqual(['secret@example.com'])
  })

  // Claim 2: and it is still not a recipient of anything.
  it('NEVER puts a bcc address into reply_recipients', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [OUTBOUND_WITH_BCC] }))
    const res = await get(T_STUDIO.id)
    const { reply_recipients: reply } = (await res.json()).data
    expect(reply.to).toEqual(['member@example.com', 'colleague@example.com'])
    expect(reply.to).not.toContain('secret@example.com')
  })

  it('derives reply_recipients from the latest message, minus our own addresses', async () => {
    const res = await get(T_STUDIO.id)
    const { reply_recipients: reply } = (await res.json()).data
    expect(reply).toEqual({
      to: ['member@example.com', 'colleague@example.com'],
      mode: 'reply_all',
    })
  })

  it('reports a one-person thread as a plain reply', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [{ ...CC_INBOUND, cc_emails: [] }],
    }))
    const res = await get(T_STUDIO.id)
    expect((await res.json()).data.reply_recipients)
      .toEqual({ to: ['member@example.com'], mode: 'reply' })
  })

  it('falls back to the requester on a ticket with no messages', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [] }))
    const res = await get(T_STUDIO.id)
    expect((await res.json()).data.reply_recipients)
      .toEqual({ to: [T_STUDIO.requester_email], mode: 'reply' })
  })
})

// EMAIL-ASSIGN.1 — the thread header needs the assignee's name and whether
// the viewer may reassign; both resolved here, where the service role can
// read `profiles`.
describe('assignment enrichment', () => {
  it('resolves assignee_name on the ticket, null when unassigned or unresolvable', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO, assigned_to: 'profile-owner' }],
      messages: MESSAGES,
      profiles: [{ id: 'profile-owner', full_name: 'Orla Owner', role: 'owner' }],
    }))
    const body = await (await get(T_STUDIO.id)).json()
    expect(body.data.ticket.assignee_name).toBe('Orla Owner')

    setupDb(baseState({ grants: [GRANT_STUDIO], messages: MESSAGES }))
    const unassigned = await (await get(T_STUDIO.id)).json()
    expect(unassigned.data.ticket.assignee_name).toBeNull()
  })

  it('carries viewer_is_elevated for the reassign control', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: MESSAGES }))
    expect((await (await get(T_STUDIO.id)).json()).data.viewer_is_elevated).toBe(true)

    getCurrentUser.mockResolvedValue(COACH)
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: MESSAGES }))
    expect((await (await get(T_STUDIO.id)).json()).data.viewer_is_elevated).toBe(false)
  })
})
