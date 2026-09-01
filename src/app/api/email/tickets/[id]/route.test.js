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
    // TWO reads since EMAIL-PARTICIPANTS.4: the thread to render, and the
    // narrower participant scan the reply audience is derived from. The claim
    // is about every one of them — a reintroduced conversation_id in either
    // would be the same live dependency on a column being dropped.
    const thread = selectsFrom(db, 'email_inbox_messages')
    expect(thread).toHaveLength(2)
    for (const read of thread) expect(read.columns).not.toContain('conversation_id')
    // …while the RENDER read still asks for the columns the thread genuinely
    // shows. (The participant scan deliberately asks for far less — and never
    // for bcc_emails.)
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

  // Was 'derives reply_recipients from the latest message' until
  // EMAIL-PARTICIPANTS.4 — the latest message IS the whole thread here (one
  // message), so the addresses are unchanged; only the rule that produced them
  // moved. `over_cap` and `empty` come with resolveReplyAudience.
  it('derives reply_recipients from the thread, minus our own addresses', async () => {
    const res = await get(T_STUDIO.id)
    const { reply_recipients: reply } = (await res.json()).data
    expect(reply).toEqual({
      to: ['member@example.com', 'colleague@example.com'],
      mode: 'reply_all',
      over_cap: false,
      empty: false,
    })
  })

  it('reports a one-person thread as a plain reply', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [{ ...CC_INBOUND, cc_emails: [] }],
    }))
    const res = await get(T_STUDIO.id)
    expect((await res.json()).data.reply_recipients)
      .toEqual({ to: ['member@example.com'], mode: 'reply', over_cap: false, empty: false })
  })

  it('falls back to the requester on a ticket with no messages', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [] }))
    const res = await get(T_STUDIO.id)
    expect((await res.json()).data.reply_recipients)
      .toEqual({ to: [T_STUDIO.requester_email], mode: 'reply', over_cap: false, empty: false })
  })
})

// ── EMAIL-PARTICIPANTS.4 — the audience is the WHOLE thread ─────────────
//
// The live failure of 2026-08-12: a shared council mailbox opened a thread, a
// named officer in that office answered from her own address, and the staff
// reply reached her ALONE — the audience was derived from the newest message
// only, so whoever wrote last silently redefined who the conversation was
// with. Nobody saw a dropped recipient; the reply simply never arrived at the
// mailbox that had asked the question.
describe('GET …/[id] — reply_recipients unions the whole thread (EMAIL-PARTICIPANTS.4)', () => {
  const OPENED_TO_SHARED_MAILBOX = {
    id: 'm-rates', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', is_internal_note: false, text_body: 'Rates query',
    from_email: MB_STUDIO.address,
    to_email: 'rates@council.ie', to_emails: ['rates@council.ie'],
    cc_emails: [], bcc_emails: [],
    created_at: '2026-08-12T09:10:00Z',
  }
  const ANSWERED_BY_ONE_OFFICER = {
    id: 'm-eleanor', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', is_internal_note: false, text_body: 'I have this now.',
    from_email: 'eleanor@council.ie',
    to_email: MB_STUDIO.address, to_emails: [MB_STUDIO.address],
    cc_emails: [], bcc_emails: [],
    created_at: '2026-08-12T10:06:00Z',
  }

  it('keeps a correspondent who is on an EARLIER message but not the newest', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [OPENED_TO_SHARED_MAILBOX, ANSWERED_BY_ONE_OFFICER],
    }))
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    const { reply_recipients: reply } = (await res.json()).data
    // The officer who wrote last is on it…
    expect(reply.to).toContain('eleanor@council.ie')
    // …and so is the shared mailbox that opened the thread. Dropping it is the
    // bug; a wider window is the fix.
    expect(reply.to).toContain('rates@council.ie')
    // Our own address is still never a recipient — a reply-all that mailed
    // studio@ would re-enter our own inbound webhook and file onto this ticket.
    expect(reply.to).not.toContain(MB_STUDIO.address)
    expect(reply.over_cap).toBe(false)
  })

  // The audience read has its OWN failure path, and 'the messages query errors'
  // above cannot reach it: `state.errors` fails every operation on the table, so
  // the route refuses at the render read long before the audience is derived.
  // An error branch nobody ever takes is the defect class this repo keeps
  // getting bitten by, so this fails ONE of the two reads and not the other.
  it('500s when only the participant lookup errors — never a quietly narrower audience', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [OPENED_TO_SHARED_MAILBOX, ANSWERED_BY_ONE_OFFICER],
    }))
    // The two reads of email_inbox_messages are told apart by what they ASK
    // for: the render read pulls bodies, the audience read deliberately does
    // not (and never asks for bcc_emails). Same db.from wrapping the reply
    // route's own tests use to make a single access fail.
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'email_inbox_messages') return b
      const realThen = b.then
      b.then = (res, rej) => (
        String(b._select).includes('html_body')
          ? realThen(res, rej)
          : Promise.resolve({
            data: null,
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
          }).then(res, rej)
      )
      return b
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await get(T_STUDIO.id)

    expect(res.status).toBe(500)
    // The reason travels, and the RENDER read succeeded — so this is the
    // participant branch refusing, not the messages branch tested twice.
    expect((await res.json()).error).toContain('statement timeout')
    expect(errors).toHaveBeenCalledWith(
      '[tickets/:id] participant lookup failed:',
      'canceling statement due to statement timeout',
    )
    errors.mockRestore()
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

// EMAIL-MERGE.5 — the survivor pointer reaches the client.
//
// A merged ticket is a TOMBSTONE (status `closed` plus merged_into_id), and
// scopeToUnmerged hides it from the queue and the badge. This route is
// deliberately NOT scoped that way: a bookmark or a push-notification link
// pointing at a ticket that has since been folded into another must land
// somewhere useful, not on "Not found". So the ticket stays READABLE and the
// payload carries the pointer, which is the only thing the UI can redirect on.
//
// Both halves are pinned here because either alone is useless: a readable
// tombstone with no pointer is a dead end (the operator reads a thread whose
// messages have moved and has no way to reach the live one), and a pointer on
// a 404 never arrives.
describe('a merged ticket keeps pointing at its survivor', () => {
  it('returns merged_into_id — the redirect target — rather than 404ing', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [
        { ...T_STUDIO },
        // The tombstone: T_ACCOUNTS folded into T_STUDIO. Put on the mailbox
        // the coach CAN see, so this test is about the merge and not about the
        // per-account gate the tests above already own.
        {
          ...T_ACCOUNTS,
          mailbox_id: MB_STUDIO.id,
          status: 'closed',
          merged_into_id: T_STUDIO.id,
          merged_at: '2026-08-12T10:00:00Z',
          merged_by: OWNER.id,
        },
      ],
      messages: MESSAGES,
    }))

    const res = await get(T_ACCOUNTS.id)

    // READABLE. A tombstone that 404s turns every link to it into a dead end.
    expect(res.status).toBe(200)
    const { data } = await res.json()

    // …and it names where the conversation went. Without this the UI has
    // nothing to redirect on and the operator is reading an emptied thread
    // with no way to reach the live one.
    expect(data.ticket.merged_into_id).toBe(T_STUDIO.id)
    // The other two merge columns ride along, so the banner can say when and
    // by whom without a second request.
    expect(data.ticket.merged_at).toBe('2026-08-12T10:00:00Z')
    expect(data.ticket.merged_by).toBe(OWNER.id)

    // AND THE READ ACTUALLY ASKS FOR THEM. The three assertions above pass on
    // this fake whatever the route selects — _test-db records the column list
    // but does not PROJECT by it, so a select narrowed to a hand-written column
    // set would still hand back a whole fixture row here while returning
    // undefined against Postgres. Pinning the select is what makes this a test
    // of the route rather than of the double: loadTicketForUser reads `*`, so
    // every mig 536 column arrives, and narrowing it later fails HERE instead
    // of silently emptying the banner in production.
    const [ticketRead] = selectsFrom(db, 'email_tickets')
    expect(
      ticketRead.columns === '*' || ticketRead.columns.includes('merged_into_id')
    ).toBe(true)
  })

  it('leaves merged_into_id null on an ordinary ticket', async () => {
    // The negative half: a pointer that is always set is a banner that always
    // shows, and the UI keys the merged banner on exactly this field.
    const { data } = await (await get(T_STUDIO.id)).json()
    expect(data.ticket.merged_into_id ?? null).toBeNull()
  })
})

// ── MAIL-REFINE.2 — merged-in provenance for the thread divider ─────────
describe('merged_sources', () => {
  const TOMBSTONE = {
    id: 'aaaaaaa7-0000-4000-8000-000000000007',
    location_id: T_STUDIO.location_id, mailbox_id: T_STUDIO.mailbox_id,
    requester_email: T_STUDIO.requester_email, status: 'open',
    subject: 'RE: Meter reading — urgent',
    merged_into_id: T_STUDIO.id, merged_at: '2026-08-31T20:00:00Z',
  }
  const ABSORBED = {
    id: 'm-merged-1', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', from_email: T_STUDIO.requester_email,
    text_body: 'The reading is 048122.', created_at: '2026-08-28T10:00:00Z',
    merged_from_ticket_id: TOMBSTONE.id,
  }

  it('names each absorbed conversation once, subject included', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO }, TOMBSTONE],
      messages: [...MESSAGES, ABSORBED, { ...ABSORBED, id: 'm-merged-2' }],
    }))
    const res = await get(T_STUDIO.id)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.merged_sources).toEqual([
      { id: TOMBSTONE.id, subject: 'RE: Meter reading — urgent', merged_at: '2026-08-31T20:00:00Z' },
    ])
    // …and the messages themselves carry the stamp the divider keys on.
    const absorbed = body.data.messages.filter(m => m.merged_from_ticket_id === TOMBSTONE.id)
    expect(absorbed).toHaveLength(2)
  })

  it('is [] when nothing was ever merged in', async () => {
    const res = await get(T_STUDIO.id)
    expect((await res.json()).data.merged_sources).toEqual([])
  })
})
