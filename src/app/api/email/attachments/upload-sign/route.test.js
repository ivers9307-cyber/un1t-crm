// EMAIL-OUTBOUND-ATTACH.1 — authorising a browser upload.
//
// This route is the reason the bytes never touch Vercel, and it is also the
// only place a staff member is granted write access to a shared bucket. Two
// properties carry all the weight:
//
//   • THE GATE IS THE SEND'S OWN. Signing an upload is, a moment later,
//     permission to email a file from a studio's address. A weaker check here
//     than on the send would be a way around the send's.
//   • THE CLIENT NEVER NAMES A PATH. The key is built from the session's own
//     profile id, so a token can only ever be minted for the caller's own
//     drafts — never another person's, never the canonical <location_id>/…
//     half of the bucket, never the shim's inbound/… half.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES } from '@/lib/email-outbound-attachments'
import { makeDb, writesTo } from '../../tickets/_test-db'
import {
  MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, GRANT_STUDIO, baseState,
} from '../../tickets/_test-fixtures'

const DRAFT = '22222222-2222-4222-8222-222222222222'
const UNKNOWN = '99999999-9999-4999-8999-999999999999'

function post(body) {
  return POST(new Request('http://x/api/email/attachments/upload-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const FILE = { draft_id: DRAFT, index: 0, filename: 'invoice.pdf', mime: 'application/pdf', size: 2048 }

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  getCurrentUser.mockResolvedValue(COACH)
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
})

describe('POST /api/email/attachments/upload-sign — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ ...FILE, ticket_id: T_STUDIO.id })).status).toBe(401)
  })

  it('400s when neither a ticket nor a mailbox is named', async () => {
    expect((await post(FILE)).status).toBe(400)
  })

  it('400s when BOTH are named — there is no third authorisation shape', async () => {
    const res = await post({ ...FILE, ticket_id: T_STUDIO.id, mailbox_id: MB_STUDIO.id })
    expect(res.status).toBe(400)
  })

  it('400s on a malformed body', async () => {
    expect((await post({ ticket_id: T_STUDIO.id })).status).toBe(400)
    expect((await post({ ...FILE, index: 99, ticket_id: T_STUDIO.id })).status).toBe(400)
    expect((await post({ ...FILE, draft_id: '../..', ticket_id: T_STUDIO.id })).status).toBe(400)
    expect((await post({ ...FILE, size: 0, ticket_id: T_STUDIO.id })).status).toBe(400)
  })
})

describe('POST …/upload-sign — the TICKET gate is the reply route’s', () => {
  it('signs an upload for a ticket the caller can work', async () => {
    const res = await post({ ...FILE, ticket_id: T_STUDIO.id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.path).toBe(`outbound/${COACH.id}/${DRAFT}/0.pdf`)
    expect(body.data.token).toBeTruthy()
  })

  it('404s on a ticket whose MAILBOX the caller cannot see', async () => {
    // The exact hole the per-account model exists to close: accounts@ carries
    // billing correspondence, and signing an upload against it would be a way
    // to attach a file to a reply the caller cannot send.
    expect((await post({ ...FILE, ticket_id: T_ACCOUNTS.id })).status).toBe(404)
  })

  it('404s on a ticket at another studio', async () => {
    expect((await post({ ...FILE, ticket_id: T_OTHER_LOCATION.id })).status).toBe(404)
  })

  it('404s without the email_inbox key at the TICKET’S location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post({ ...FILE, ticket_id: T_STUDIO.id })).status).toBe(404)
  })

  it('404s on a ticket that does not exist', async () => {
    expect((await post({ ...FILE, ticket_id: UNKNOWN })).status).toBe(404)
  })
})

describe('POST …/upload-sign — the MAILBOX gate is the compose route’s', () => {
  it('signs an upload for a mailbox the caller may send as', async () => {
    const res = await post({ ...FILE, mailbox_id: MB_STUDIO.id })
    expect(res.status).toBe(200)
    expect((await res.json()).data.path).toBe(`outbound/${COACH.id}/${DRAFT}/0.pdf`)
  })

  it('404s on a mailbox the caller cannot send as', async () => {
    expect((await post({ ...FILE, mailbox_id: MB_ACCOUNTS.id })).status).toBe(404)
  })

  it('404s on another studio’s mailbox', async () => {
    expect((await post({ ...FILE, mailbox_id: MB_OTHER_LOCATION.id })).status).toBe(404)
  })

  it('404s on a mailbox that does not exist', async () => {
    expect((await post({ ...FILE, mailbox_id: UNKNOWN })).status).toBe(404)
  })

  it('404s without the email_inbox key at the MAILBOX’S location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post({ ...FILE, mailbox_id: MB_STUDIO.id })).status).toBe(404)
  })

  it('500s rather than 404s when the visibility lookup itself fails', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], errors: { email_mailbox_access: { code: '42501', message: 'denied' } } }))
    expect((await post({ ...FILE, mailbox_id: MB_STUDIO.id })).status).toBe(500)
  })
})

describe('POST …/upload-sign — the key', () => {
  it('is built from the CALLER’S profile id, whatever they say', async () => {
    // There is no field on this request that could name a different prefix —
    // the assertion is that the returned path contains the session's id.
    const res = await post({ ...FILE, ticket_id: T_STUDIO.id })
    const { data } = await res.json()
    expect(data.path.startsWith(`outbound/${COACH.id}/`)).toBe(true)
    expect(data.path).not.toContain('..')
    expect(data.path).not.toContain('inbound/')
    expect(data.path.startsWith(T_STUDIO.location_id)).toBe(false)
  })

  it('takes its extension from the MIME, never from the filename', async () => {
    const res = await post({
      ...FILE, ticket_id: T_STUDIO.id, filename: 'invoice.exe', mime: 'image/png',
    })
    expect((await res.json()).data.path.endsWith('/0.png')).toBe(true)
  })

  it('gives each slot its own key', async () => {
    const a = await (await post({ ...FILE, index: 0, ticket_id: T_STUDIO.id })).json()
    const b = await (await post({ ...FILE, index: 4, ticket_id: T_STUDIO.id })).json()
    expect(a.data.path).not.toBe(b.data.path)
    expect(b.data.path.endsWith('/4.pdf')).toBe(true)
  })
})

describe('POST …/upload-sign — size and side effects', () => {
  it('refuses a single file over the whole-message ceiling, before any DB work', async () => {
    const res = await post({
      ...FILE, ticket_id: T_STUDIO.id, size: MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES + 1,
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('7.0 MB')
  })

  it('charges no quota and writes no row — a draft is not an attachment', async () => {
    await post({ ...FILE, ticket_id: T_STUDIO.id })
    expect(writesTo(db)).toEqual([])
    expect(db.rpcs).toEqual([])
  })

  it('500s when Storage will not mint a token', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], storageErrors: { signUpload: { message: 'nope' } } }))
    expect((await post({ ...FILE, ticket_id: T_STUDIO.id })).status).toBe(500)
  })
})
