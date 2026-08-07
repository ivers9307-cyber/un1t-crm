// EMAIL-ATTACH.1 — the attachment download route.
//
// THE PROPERTY THIS FILE EXISTS FOR
// The signed URL this route mints is a bearer handle to a private object. The
// gate is the TICKET's gate (loadTicketForUser), plus one extra check that the
// attachment actually belongs to that ticket — and that extra check is the
// whole IDOR. Without it, a coach with a grant on studio@ could pass a ticket
// they can open together with ANY attachment id in the estate and be handed the
// bytes of the billing correspondence the per-mailbox model exists to withhold.
//
// Every refusal is 404, never 403, so an attachment id cannot be probed. The
// tests below assert NO URL IS RETURNED, not merely the status code: a route
// that 404s after signing has already leaked nothing, but a route that signs
// and then decides is one refactor away from returning it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb } from '../../../_test-db'
import {
  LOC_A, T_STUDIO, T_ACCOUNTS, COACH, COACH_NO_INBOX, OWNER, GRANT_STUDIO, baseState,
} from '../../../_test-fixtures'

const STUDIO_MSG = { id: 'm-studio', ticket_id: T_STUDIO.id, location_id: LOC_A }
const ACCOUNTS_MSG = { id: 'm-accounts', ticket_id: T_ACCOUNTS.id, location_id: LOC_A }

const STUDIO_ATT = {
  id: 'att-studio', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 0,
  filename: 'timetable.pdf', mime_type: 'application/pdf', size_bytes: 2048,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/0.pdf`, skipped_reason: null,
}
/** On the mailbox the coach has NO grant for. The thing being protected. */
const ACCOUNTS_ATT = {
  id: 'att-accounts', message_id: ACCOUNTS_MSG.id, location_id: LOC_A,
  mailbox_id: T_ACCOUNTS.mailbox_id, attachment_index: 0,
  filename: 'bank-statement.pdf', mime_type: 'application/pdf', size_bytes: 4096,
  storage_path: `${LOC_A}/${ACCOUNTS_MSG.id}/0.pdf`, skipped_reason: null,
}
const SKIPPED_ATT = {
  id: 'att-skipped', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 1,
  filename: 'huge.zip', mime_type: 'application/zip', size_bytes: 30_000_000,
  storage_path: null, skipped_reason: 'quota',
}

function state(extra = {}) {
  const s = baseState({
    messages: [STUDIO_MSG, ACCOUNTS_MSG],
    attachments: [STUDIO_ATT, ACCOUNTS_ATT, SKIPPED_ATT],
    grants: [GRANT_STUDIO],
    ...extra,
  })
  // The signer only answers for objects that are actually in the bucket, so
  // seed the two stored ones.
  s.objects = new Map([
    [`email-attachments/${STUDIO_ATT.storage_path}`, { bytes: 'x' }],
    [`email-attachments/${ACCOUNTS_ATT.storage_path}`, { bytes: 'x' }],
  ])
  return s
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  db = makeDb(state())
  createServerClient.mockImplementation(() => db)
})

async function get(ticketId, attachmentId) {
  const res = await GET(
    new Request(`http://x/api/email/tickets/${ticketId}/attachments/${attachmentId}`),
    { params: Promise.resolve({ id: ticketId, attachmentId }) }
  )
  return { res, body: await res.json() }
}

describe('the gate', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { res } = await get(T_STUDIO.id, STUDIO_ATT.id)
    expect(res.status).toBe(401)
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
    const { res } = await get(T_STUDIO.id, STUDIO_ATT.id)
    expect(res.status).toBe(404)
  })

  it('signs an attachment on a mailbox the caller CAN see', async () => {
    const { res, body } = await get(T_STUDIO.id, STUDIO_ATT.id)
    expect(res.status).toBe(200)
    expect(body.data.url).toContain('token=signed')
    expect(body.data.filename).toBe('timetable.pdf')
    expect(body.data.size_bytes).toBe(2048)
    // storage_path is not a field of the response. (It is necessarily inside
    // the signed URL — that is what a signed URL is — but a client must never
    // be handed the raw key to address the bucket with on its own.)
    expect(body.data.storage_path).toBeUndefined()
    expect(Object.keys(body.data).sort())
      .toEqual(['expires_in', 'filename', 'mime_type', 'size_bytes', 'url'])
  })

  it('404s — never 403 — on a mailbox the caller cannot see', async () => {
    const { res, body } = await get(T_ACCOUNTS.id, ACCOUNTS_ATT.id)
    expect(res.status).toBe(404)
    expect(body.data?.url).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('storage.test')
  })

  // THE IDOR. A ticket the caller CAN open, plus an attachment id from one
  // they cannot. Both halves are individually legitimate; only the pairing
  // check refuses it.
  it('REFUSES an attachment from another ticket even when the ticket id is legitimate', async () => {
    const { res, body } = await get(T_STUDIO.id, ACCOUNTS_ATT.id)
    expect(res.status).toBe(404)
    expect(JSON.stringify(body)).not.toContain('storage.test')
  })

  it('refuses the same pairing for an elevated caller too — it is not a permissions question', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    // An owner may open BOTH tickets, so this is purely "that file is not on
    // that ticket".
    expect((await get(T_STUDIO.id, ACCOUNTS_ATT.id)).res.status).toBe(404)
    // …and the correct pairing still works for them.
    expect((await get(T_ACCOUNTS.id, ACCOUNTS_ATT.id)).res.status).toBe(200)
  })

  it('404s for an unknown attachment id and for a malformed one', async () => {
    expect((await get(T_STUDIO.id, 'no-such-id')).res.status).toBe(404)
    expect((await get(T_STUDIO.id, 'not a uuid')).res.status).toBe(404)
  })

  it('404s for an unknown ticket id without ever looking at the attachment', async () => {
    const { res } = await get('aaaaaaa9-0000-4000-8000-000000000009', STUDIO_ATT.id)
    expect(res.status).toBe(404)
  })
})

describe('an attachment that was never stored', () => {
  it('404s and NAMES the reason so staff can ask for a resend', async () => {
    const { res, body } = await get(T_STUDIO.id, SKIPPED_ATT.id)
    expect(res.status).toBe(404)
    expect(body.data.skipped_reason).toBe('quota')
    expect(body.error).toMatch(/full/i)
  })
})

describe('when Storage will not sign', () => {
  it('500s rather than 404ing — "missing from the bucket" is not "you may not have it"', async () => {
    db._state.storageErrors.sign = { message: 'signer down' }
    const { res } = await get(T_STUDIO.id, STUDIO_ATT.id)
    expect(res.status).toBe(500)
  })
})
