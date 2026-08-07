// EMAIL-ATTACH-PREVIEW.1 — the INLINE preview route.
//
// THE TWO PROPERTIES THIS FILE EXISTS FOR
//
// 1. It is gated exactly like the download route beside it — the ticket's gate
//    plus the attachment-belongs-to-this-ticket pairing check. Both routes hand
//    out a bearer handle to a private object; a preview URL that were reachable
//    one notch wider than the download URL would be the whole IDOR back again,
//    on the newer of the two files where nobody would look for it. So the gate
//    tests below are deliberately the SAME tests as ../route.test.js.
//
// 2. It mints an INLINE url ONLY for the allow-list. `image/svg+xml` is the
//    type that matters: scriptable markup from an unauthenticated stranger,
//    which must never acquire a handle that renders rather than downloads. The
//    assertions check no URL is returned, not merely the status code — a route
//    that signs and then decides is one refactor away from returning it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { GET as DOWNLOAD } from '../route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb } from '../../../../_test-db'
import {
  LOC_A, T_STUDIO, T_ACCOUNTS, COACH, COACH_NO_INBOX, OWNER, GRANT_STUDIO, baseState,
} from '../../../../_test-fixtures'

const STUDIO_MSG = { id: 'm-studio', ticket_id: T_STUDIO.id, location_id: LOC_A }
const ACCOUNTS_MSG = { id: 'm-accounts', ticket_id: T_ACCOUNTS.id, location_id: LOC_A }

/** The case the whole feature exists for: a member emails a photo. */
const PHOTO = {
  id: 'att-photo', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 0,
  filename: 'IMG_4821.jpeg', mime_type: 'image/jpeg', size_bytes: 2_100_000,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/0.jpg`, skipped_reason: null,
}
const PDF = {
  id: 'att-pdf', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 1,
  filename: 'timetable.pdf', mime_type: 'application/pdf', size_bytes: 2048,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/1.pdf`, skipped_reason: null,
}
/** Scriptable markup from a stranger. Must never get an inline URL. */
const SVG = {
  id: 'att-svg', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 2,
  filename: 'logo.svg', mime_type: 'image/svg+xml', size_bytes: 900,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/2.svg`, skipped_reason: null,
}
/** An iPhone photo. No browser renders it — download only, no broken image. */
const HEIC = {
  id: 'att-heic', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 3,
  filename: 'IMG_4822.heic', mime_type: 'image/heic', size_bytes: 1_800_000,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/3.heic`, skipped_reason: null,
}
const DOCX = {
  id: 'att-docx', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 4,
  filename: 'letter.docx',
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size_bytes: 40_000,
  storage_path: `${LOC_A}/${STUDIO_MSG.id}/4.document`, skipped_reason: null,
}
/** A photo on the mailbox the coach has NO grant for. The thing protected. */
const ACCOUNTS_PHOTO = {
  id: 'att-accounts', message_id: ACCOUNTS_MSG.id, location_id: LOC_A,
  mailbox_id: T_ACCOUNTS.mailbox_id, attachment_index: 0,
  filename: 'statement-scan.png', mime_type: 'image/png', size_bytes: 4096,
  storage_path: `${LOC_A}/${ACCOUNTS_MSG.id}/0.png`, skipped_reason: null,
}
const SKIPPED = {
  id: 'att-skipped', message_id: STUDIO_MSG.id, location_id: LOC_A,
  mailbox_id: T_STUDIO.mailbox_id, attachment_index: 5,
  filename: 'huge.png', mime_type: 'image/png', size_bytes: 30_000_000,
  storage_path: null, skipped_reason: 'quota',
}

const STORED = [PHOTO, PDF, SVG, HEIC, DOCX, ACCOUNTS_PHOTO]

function state() {
  const s = baseState({
    messages: [STUDIO_MSG, ACCOUNTS_MSG],
    attachments: [...STORED, SKIPPED],
    grants: [GRANT_STUDIO],
  })
  // The signer only answers for objects actually in the bucket.
  s.objects = new Map(STORED.map(a => [`email-attachments/${a.storage_path}`, { bytes: 'x' }]))
  return s
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  db = makeDb(state())
  createServerClient.mockImplementation(() => db)
})

async function preview(ticketId, attachmentId) {
  const res = await GET(
    new Request(`http://x/api/email/tickets/${ticketId}/attachments/${attachmentId}/preview`),
    { params: Promise.resolve({ id: ticketId, attachmentId }) }
  )
  return { res, body: await res.json() }
}

async function download(ticketId, attachmentId) {
  const res = await DOWNLOAD(
    new Request(`http://x/api/email/tickets/${ticketId}/attachments/${attachmentId}`),
    { params: Promise.resolve({ id: ticketId, attachmentId }) }
  )
  return { res, body: await res.json() }
}

describe('the gate — the same one as the download route', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { res } = await preview(T_STUDIO.id, PHOTO.id)
    expect(res.status).toBe(401)
  })

  it('404s without the email_inbox permission AT THE TICKET’S location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    const { res } = await preview(T_STUDIO.id, PHOTO.id)
    expect(res.status).toBe(404)
  })

  it('404s — never 403 — on a mailbox the caller cannot see', async () => {
    const { res, body } = await preview(T_ACCOUNTS.id, ACCOUNTS_PHOTO.id)
    expect(res.status).toBe(404)
    expect(body.data?.url).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('storage.test')
  })

  // THE IDOR. A ticket the caller CAN open, plus an attachment id from one they
  // cannot. Both halves are individually legitimate; only the pairing check
  // refuses it — and it must refuse the preview exactly as it refuses the
  // download, or the newer route is a way around the older one.
  it('REFUSES an attachment from another ticket even when the ticket id is legitimate', async () => {
    const { res, body } = await preview(T_STUDIO.id, ACCOUNTS_PHOTO.id)
    expect(res.status).toBe(404)
    expect(JSON.stringify(body)).not.toContain('storage.test')
  })

  it('refuses the same pairing for an elevated caller too — it is not a permissions question', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    expect((await preview(T_STUDIO.id, ACCOUNTS_PHOTO.id)).res.status).toBe(404)
    expect((await preview(T_ACCOUNTS.id, ACCOUNTS_PHOTO.id)).res.status).toBe(200)
  })

  it('404s for an unknown attachment id, a malformed one, and an unknown ticket', async () => {
    expect((await preview(T_STUDIO.id, 'no-such-id')).res.status).toBe(404)
    expect((await preview(T_STUDIO.id, 'not a uuid')).res.status).toBe(404)
    expect((await preview('aaaaaaa9-0000-4000-8000-000000000009', PHOTO.id)).res.status).toBe(404)
  })

  // Belt and braces on the whole pairing: whatever the download route refuses,
  // this route refuses identically. Written as a loop over the refusals rather
  // than one more example, because the property is "the two agree", and a
  // divergence introduced later would be exactly one missing case.
  it('agrees with the download route on every refusal', async () => {
    const pairs = [
      [T_STUDIO.id, ACCOUNTS_PHOTO.id],
      [T_ACCOUNTS.id, PHOTO.id],
      [T_ACCOUNTS.id, ACCOUNTS_PHOTO.id],
      [T_STUDIO.id, 'no-such-id'],
      [T_STUDIO.id, SKIPPED.id],
    ]
    for (const [ticketId, attId] of pairs) {
      const p = await preview(ticketId, attId)
      const d = await download(ticketId, attId)
      expect(p.res.status, `${ticketId}/${attId}`).toBe(d.res.status)
    }
  })
})

describe('image/svg+xml', () => {
  // The assertion this route was written around.
  it('gets NO inline url, ever', async () => {
    const { res, body } = await preview(T_STUDIO.id, SVG.id)
    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.data?.url).toBeUndefined()
    // Not merely "no url field" — no signed URL anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('storage.test')
    expect(JSON.stringify(body)).not.toContain('token=signed')
  })

  it('is never signed at all — the refusal happens before Storage is asked', async () => {
    // A route that signs and then decides has already put the URL in memory and
    // is one careless return away from shipping it.
    const before = db._state.objects.size
    await preview(T_STUDIO.id, SVG.id)
    expect(db._state.objects.size).toBe(before)
  })

  it('still DOWNLOADS cleanly, under its own filename', async () => {
    // The guarantee for every unsupported type: the file is still reachable,
    // and Content-Disposition: attachment makes it inert.
    const { res, body } = await download(T_STUDIO.id, SVG.id)
    expect(res.status).toBe(200)
    expect(body.data.url).toContain('download=logo.svg')
  })
})

describe('image/heic — a real photo no browser can draw', () => {
  it('gets no preview url', async () => {
    const { res, body } = await preview(T_STUDIO.id, HEIC.id)
    expect(res.status).toBe(404)
    expect(body.data?.preview_kind).toBeNull()
    expect(JSON.stringify(body)).not.toContain('token=signed')
  })

  it('downloads under the name the member sent', async () => {
    const { res, body } = await download(T_STUDIO.id, HEIC.id)
    expect(res.status).toBe(200)
    expect(body.data.url).toContain(`download=${encodeURIComponent('IMG_4822.heic')}`)
  })
})

describe('Office formats', () => {
  it('get no preview — browsers cannot render them and nothing is sent to a third party', async () => {
    const { res } = await preview(T_STUDIO.id, DOCX.id)
    expect(res.status).toBe(404)
  })

  it('download cleanly', async () => {
    const { body } = await download(T_STUDIO.id, DOCX.id)
    expect(body.data.url).toContain('download=letter.docx')
  })
})

describe('an attachment that was never stored', () => {
  it('404s and NAMES the reason, so the chip can keep saying it', async () => {
    const { res, body } = await preview(T_STUDIO.id, SKIPPED.id)
    expect(res.status).toBe(404)
    expect(body.data.skipped_reason).toBe('quota')
    expect(body.error).toMatch(/full/i)
  })
})

describe('a photo the operator is allowed to see', () => {
  it('signs an INLINE url — no download flag', async () => {
    const { res, body } = await preview(T_STUDIO.id, PHOTO.id)
    expect(res.status).toBe(200)
    expect(body.data.url).toContain('token=signed')
    expect(body.data.preview_kind).toBe('image')
    // THE DIFFERENCE BETWEEN THE TWO ROUTES, asserted directly: the download
    // option is the only thing that varies, and it is absent here.
    expect(body.data.url).not.toContain('download=')
  })

  it('the download route signs the SAME object WITH the download flag', async () => {
    const p = await preview(T_STUDIO.id, PHOTO.id)
    const d = await download(T_STUDIO.id, PHOTO.id)
    expect(d.body.data.url).toContain(`download=${encodeURIComponent(PHOTO.filename)}`)
    // Same path, same ttl, one option apart.
    expect(p.body.data.url.split('?')[0]).toBe(d.body.data.url.split('?')[0])
  })

  it('never returns storage_path, and returns a fixed field set', async () => {
    const { body } = await preview(T_STUDIO.id, PHOTO.id)
    expect(body.data.storage_path).toBeUndefined()
    expect(Object.keys(body.data).sort()).toEqual(
      ['expires_in', 'filename', 'mime_type', 'preview_kind', 'size_bytes', 'url'],
    )
  })

  it('carries the same short TTL as the download route', async () => {
    const { body } = await preview(T_STUDIO.id, PHOTO.id)
    expect(body.data.expires_in).toBe(300)
    expect(body.data.url).toContain('ttl=300')
  })

  it('takes no parameters — a query string cannot change what it mints', async () => {
    // Every knob a caller might reach for, at once. The response must be
    // byte-identical to the bare request: this route has no inputs but the two
    // path ids, which is what stops a request choosing a Storage option.
    const withJunk = await GET(
      new Request(
        `http://x/api/email/tickets/${T_STUDIO.id}/attachments/${PHOTO.id}/preview`
        + '?download=evil.html&disposition=attachment&transform=1&ttl=99999&expiresIn=99999',
      ),
      { params: Promise.resolve({ id: T_STUDIO.id, attachmentId: PHOTO.id }) },
    )
    const junkBody = await withJunk.json()
    const plain = await preview(T_STUDIO.id, PHOTO.id)
    expect(junkBody).toEqual(plain.body)
    expect(junkBody.data.url).not.toContain('download=')
    expect(junkBody.data.url).not.toContain('99999')
  })
})

describe('a PDF the operator is allowed to see', () => {
  it('previews as a pdf, inline', async () => {
    const { res, body } = await preview(T_STUDIO.id, PDF.id)
    expect(res.status).toBe(200)
    expect(body.data.preview_kind).toBe('pdf')
    expect(body.data.url).not.toContain('download=')
  })
})

describe('when Storage will not sign', () => {
  it('500s rather than 404ing — "missing from the bucket" is not "you may not have it"', async () => {
    db._state.storageErrors.sign = { message: 'signer down' }
    const { res } = await preview(T_STUDIO.id, PHOTO.id)
    expect(res.status).toBe(500)
  })
})

describe('no route on this surface ever writes', () => {
  it('a preview is a read, whatever the outcome', async () => {
    await preview(T_STUDIO.id, PHOTO.id)
    await preview(T_STUDIO.id, SVG.id)
    await preview(T_ACCOUNTS.id, ACCOUNTS_PHOTO.id)
    expect(db.inserts).toEqual([])
    expect(db.updates).toEqual([])
    expect(db.deletes).toEqual([])
  })
})
