// The mobile wire layer for the Mail surface — historically the one untested
// module
// in the email footprint (2026-08-08 audit). The case that forced the file:
// GET /api/email/tickets/[id] returns `attachments_unavailable: true` when the
// attachment lookup failed, precisely so a client can say "attachments
// unknown" instead of the silent wrong answer "no attachments". Web honours it
// (AttachmentsUnavailableNotice); mobile dropped the flag on the floor, so a
// blipped lookup rendered every message as though the member sent no files —
// the exact operator-facing lie the route's header warns about.
//
// `./api` is mocked BEFORE import: it pulls the React-Native runtime, which
// must never load under vitest's Node environment (see vitest.config.js).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))
// MOBILE-MAIL-A.1 — the upload half pulls the RN Supabase client (SecureStore,
// AppState) and the picker byte-reader; neither may load under vitest.
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

import { api } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import {
  getTicket, getMailCount, listMail, archiveConversation, setConversationSeen,
  replyToTicket, composeEmail, forwardMessage, draftUuid,
  signOutboundAttachment, uploadSignedAttachment,
  EMAIL_ATTACHMENT_BUCKET, MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES, MAX_OUTBOUND_ATTACHMENTS,
} from './email-api'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getTicket', () => {
  it('passes attachments_unavailable through — a failed lookup must not read as "no attachments"', async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1' }, messages: [], attachments_unavailable: true },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.success).toBe(true)
    expect(res.attachmentsUnavailable).toBe(true)
  })

  it('reports false when the route omits the flag — the healthy case stays quiet', async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1' }, messages: [] },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.attachmentsUnavailable).toBe(false)
  })

  it('still surfaces a failure as a failure', async () => {
    api.mockResolvedValue({ success: false, error: 'nope' })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.success).toBe(false)
    expect(res.error).toBe('nope')
  })

  // EMAIL-PARTICIPANTS.9 — reply_recipients used to be dropped here, so the
  // composer footer fell back to a hard-coded "Sends an email to <requester>"
  // even though a reply from this screen has always gone to everyone the
  // server derives (this file's replyToTicket doc — `{ text, internal }` only,
  // the route adds the rest). That understated the true audience on every
  // multi-party thread (2026-08-09 audit).
  it('passes reply_recipients through — the footer needs the real audience, not just the requester', async () => {
    api.mockResolvedValue({
      success: true,
      data: {
        ticket: { id: 'T-1' },
        messages: [],
        reply_recipients: { to: ['a@x.com', 'b@x.com'], mode: 'reply_all', over_cap: false, empty: false },
      },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.reply_recipients).toEqual({
      to: ['a@x.com', 'b@x.com'], mode: 'reply_all', over_cap: false, empty: false,
    })
  })

  it('defaults reply_recipients to null when the route could not derive one — not an invented empty/over_cap answer', async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1' }, messages: [] },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.reply_recipients).toBeNull()
  })
})

// EMAIL-ASSIGN.1 — the mobile claim path. Mirrors the web contract exactly:
// 'me' | null | <profile id>, the route decides.
// MOBILE-MAIL.1 — the mail list + the surface's two verbs.
describe('listMail', () => {
  it('asks /api/email/mail and shapes conversations into rows', async () => {
    api.mockResolvedValue({
      success: true,
      data: {
        mailboxes: [{ id: 'mb-1', label: 'Accounts', address: 'a@x.com' }],
        conversations: [{
          id: 'T-1', status: 'open', last_message_direction: 'inbound',
          unread: true, unread_count_messages: 2, has_attachments: true,
          needs_reply: true, archived: false,
        }],
        needs_reply_count: 1,
      },
    })
    const res = await listMail('loc-1', {})
    expect(api).toHaveBeenCalledWith('/api/email/mail?location_id=loc-1', { locationId: 'loc-1' })
    expect(res.success).toBe(true)
    expect(res.needsReplyCount).toBe(1)
    const [row] = res.data
    expect(row.unread).toBe(true)
    expect(row.unread_count).toBe(2)
    expect(row.has_attachments).toBe(true)
    expect(row.needs_reply).toBe(true)
  })

  it('sends the view on the wire when one is chosen', async () => {
    api.mockResolvedValue({ success: true, data: { mailboxes: [], conversations: [] } })
    await listMail('loc-1', { view: 'archived' })
    expect(api).toHaveBeenCalledWith('/api/email/mail?location_id=loc-1&view=archived', { locationId: 'loc-1' })
  })

  it('refuses locally without a location — the route would 400 anyway', async () => {
    const res = await listMail(null, {})
    expect(res.success).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })

  // Audit C2 — the route forbids either count flag to render as "all read";
  // dropping them here is exactly how a failed read-state scan became a
  // fully-triaged-looking inbox on the phone.
  it('passes counts_unavailable and counts_partial through', async () => {
    api.mockResolvedValue({
      success: true,
      data: {
        mailboxes: [], conversations: [],
        counts_unavailable: true, counts_partial: false,
      },
    })
    const res = await listMail('loc-1', {})
    expect(res.countsUnavailable).toBe(true)
    expect(res.countsPartial).toBe(false)
  })

  it('defaults both count flags to false when the route omits them', async () => {
    api.mockResolvedValue({ success: true, data: { mailboxes: [], conversations: [] } })
    const res = await listMail('loc-1', {})
    expect(res.countsUnavailable).toBe(false)
    expect(res.countsPartial).toBe(false)
  })

  // MOBILE-MAIL-A.1 — the richer list: search, keyset paging, per-account tab.
  it('sends q, before and mailbox_id on the wire when given', async () => {
    api.mockResolvedValue({ success: true, data: { mailboxes: [], conversations: [] } })
    await listMail('loc-1', { view: 'archived', q: 'invoice', before: 'cursor-1', mailboxId: 'mb-9' })
    expect(api).toHaveBeenCalledWith(
      '/api/email/mail?location_id=loc-1&view=archived&mailbox_id=mb-9&q=invoice&before=cursor-1',
      { locationId: 'loc-1' },
    )
  })

  it('omits q/before/mailbox_id from the wire when not given — the bare URL stays byte-identical to before', async () => {
    api.mockResolvedValue({ success: true, data: { mailboxes: [], conversations: [] } })
    await listMail('loc-1', { q: '', before: null, mailboxId: undefined })
    expect(api).toHaveBeenCalledWith('/api/email/mail?location_id=loc-1', { locationId: 'loc-1' })
  })

  it('returns nextBefore + searchPartial from the route', async () => {
    api.mockResolvedValue({
      success: true,
      data: {
        mailboxes: [], conversations: [],
        next_before: '2026-08-01T10:00:00Z', search_partial: true,
      },
    })
    const res = await listMail('loc-1', { q: 'x' })
    expect(res.nextBefore).toBe('2026-08-01T10:00:00Z')
    expect(res.searchPartial).toBe(true)
  })

  it('defaults nextBefore to null (last page), searchPartial to false and needsReplyCount to 0 when the route omits them', async () => {
    api.mockResolvedValue({ success: true, data: { mailboxes: [], conversations: [] } })
    const res = await listMail('loc-1', {})
    expect(res.nextBefore).toBeNull()
    expect(res.searchPartial).toBe(false)
    expect(res.needsReplyCount).toBe(0)
  })

  it('passes a failure through as a failure — a poller keeps its last state, never a confident zero', async () => {
    api.mockResolvedValue({ success: false, error: 'blip' })
    const res = await listMail('loc-1', {})
    expect(res).toEqual({ success: false, error: 'blip' })
  })
})

describe('archiveConversation / setConversationSeen', () => {
  it('posts archive to the mail route with a boolean', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await archiveConversation('T-1', 1, 'loc-1')
    expect(api).toHaveBeenCalledWith('/api/email/mail/T-1/archive', {
      method: 'POST', body: { archived: true }, locationId: 'loc-1',
    })
  })

  it('posts seen to the mail route with a boolean', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await setConversationSeen('T-1', 0, 'loc-1')
    expect(api).toHaveBeenCalledWith('/api/email/mail/T-1/seen', {
      method: 'POST', body: { seen: false }, locationId: 'loc-1',
    })
  })
})

// The Mail tab badge count. The endpoint exists precisely so this surface
// never polls the whole conversation list for a number; the wrapper's job is
// the right path + the location header, and passing failure through so the
// poller can keep its last-known count instead of flashing a confident zero.
describe('getMailCount', () => {
  it('asks the cheap count route, location-scoped', async () => {
    api.mockResolvedValue({ success: true, data: { count: 4 } })
    const res = await getMailCount('loc-1')
    expect(api).toHaveBeenCalledWith('/api/email/mail/count', { locationId: 'loc-1' })
    expect(res).toEqual({ success: true, data: { count: 4 } })
  })

  it('passes a failure through untouched — the poller keeps its last count', async () => {
    api.mockResolvedValue({ success: false, error: 'blip' })
    const res = await getMailCount('loc-1')
    expect(res.success).toBe(false)
  })
})

// MOBILE-MAIL-A.1 — reply attachments ride the same body field the route's
// ReplySchema names; the wire shape without them stays byte-identical to before
// (older bundles keep working, and a reply with no files posts what it always
// posted).
describe('replyToTicket', () => {
  it('posts { text, internal } only when there are no attachments — unchanged wire shape', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await replyToTicket('T-1', 'hello', { locationId: 'loc-1' })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/reply', {
      method: 'POST', locationId: 'loc-1', body: { text: 'hello', internal: false },
    })
  })

  it('leaves an EMPTY attachments array off the wire too', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await replyToTicket('T-1', 'hello', { locationId: 'loc-1', attachments: [] })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/reply', {
      method: 'POST', locationId: 'loc-1', body: { text: 'hello', internal: false },
    })
  })

  it('carries attachment draft refs on the body when given', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    const drafts = [{ draft_id: 'd-1', index: 0, filename: 'a.pdf', mime: 'application/pdf' }]
    await replyToTicket('T-1', 'hello', { locationId: 'loc-1', attachments: drafts })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/reply', {
      method: 'POST', locationId: 'loc-1',
      body: { text: 'hello', internal: false, attachments: drafts },
    })
  })

  it('does not attach files to an internal note — the route would send nothing, so claiming files went out would lie', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    const drafts = [{ draft_id: 'd-1', index: 0, filename: 'a.pdf', mime: 'application/pdf' }]
    await replyToTicket('T-1', 'note', { internal: true, locationId: 'loc-1', attachments: drafts })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/reply', {
      method: 'POST', locationId: 'loc-1', body: { text: 'note', internal: true },
    })
  })
})

// MOBILE-MAIL-A.1 — new email from the phone. The route owns every refusal
// (recipient cap + dedupe, size ceiling, mailbox gate); this wrapper's whole
// job is the right wire shape and passing the envelope through UNTOUCHED so
// refusals reach the composer with the route's own sentences.
describe('composeEmail', () => {
  it('posts the full wire body to the compose route', async () => {
    api.mockResolvedValue({ success: true, data: { ticket_id: 'T-9' } })
    const attachments = [{ draft_id: 'd-1', index: 0, filename: 'a.pdf', mime: 'application/pdf' }]
    const res = await composeEmail({
      mailboxId: 'mb-1',
      to: ['a@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'],
      subject: 'Hi', text: 'Body',
      attachments,
      locationId: 'loc-1',
    })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/compose', {
      method: 'POST', locationId: 'loc-1',
      body: {
        mailbox_id: 'mb-1', to: ['a@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'],
        subject: 'Hi', text: 'Body', attachments,
      },
    })
    expect(res).toEqual({ success: true, data: { ticket_id: 'T-9' } })
  })

  it('omits empty cc/bcc/attachments from the body', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await composeEmail({
      mailboxId: 'mb-1', to: ['a@x.com'], cc: [], bcc: [], attachments: [],
      subject: 'Hi', text: 'Body', locationId: 'loc-1',
    })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/compose', {
      method: 'POST', locationId: 'loc-1',
      body: { mailbox_id: 'mb-1', to: ['a@x.com'], subject: 'Hi', text: 'Body' },
    })
  })

  it('passes a refusal through untouched — the route wrote that sentence for the operator', async () => {
    api.mockResolvedValue({ success: false, error: 'One email can reach up to 25 people.' })
    const res = await composeEmail({
      mailboxId: 'mb-1', to: ['a@x.com'], subject: 'Hi', text: 'Body', locationId: 'loc-1',
    })
    expect(res).toEqual({ success: false, error: 'One email can reach up to 25 people.' })
  })
})

// MOBILE-MAIL-FORWARD.1 — pass one message on the ticket to somebody else.
// The route owns every refusal (the note ban, unstored files, the recipient
// cap, the 7 MiB ceiling re-measured on real bytes); this wrapper's whole job
// is the right wire shape and passing the envelope through UNTOUCHED.
describe('forwardMessage', () => {
  it('posts the full wire body to the ticket forward route', async () => {
    api.mockResolvedValue({ success: true, data: { message_id: 'pm-1' } })
    const res = await forwardMessage({
      ticketId: 'T-1', messageId: 'm-1',
      to: ['acct@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'],
      note: 'For the August books', attachmentIds: ['att-1', 'att-2'],
      locationId: 'loc-1',
    })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/forward', {
      method: 'POST', locationId: 'loc-1',
      body: {
        message_id: 'm-1', to: ['acct@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'],
        note: 'For the August books', attachment_ids: ['att-1', 'att-2'],
      },
    })
    expect(res).toEqual({ success: true, data: { message_id: 'pm-1' } })
  })

  it('omits empty cc/bcc/note/attachment_ids — the smallest body is the shape nothing can misread', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await forwardMessage({
      ticketId: 'T-1', messageId: 'm-1', to: ['acct@x.com'],
      cc: [], bcc: [], note: '', attachmentIds: [], locationId: 'loc-1',
    })
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/forward', {
      method: 'POST', locationId: 'loc-1',
      body: { message_id: 'm-1', to: ['acct@x.com'] },
    })
  })

  it('a whitespace-only note stays off the wire too — the route would store a blank covering note', async () => {
    api.mockResolvedValue({ success: true, data: {} })
    await forwardMessage({ ticketId: 'T-1', messageId: 'm-1', to: ['a@x.com'], note: '   ', locationId: 'loc-1' })
    const [, opts] = api.mock.calls[0]
    expect(opts.body.note).toBeUndefined()
  })

  it('passes a refusal through untouched — including the sent-but-unfiled "do not resend" answer with its data marker', async () => {
    const unfiled = {
      success: false,
      error: 'The forward was sent but could not be filed on the ticket. Do not resend — check with the recipient before trying again.',
      data: { sent: true, message_id: 'pm-9' },
    }
    api.mockResolvedValue(unfiled)
    const res = await forwardMessage({ ticketId: 'T-1', messageId: 'm-1', to: ['a@x.com'], locationId: 'loc-1' })
    expect(res).toEqual(unfiled)
  })
})

// The draft id the sign route pins with uuidLike. It carries no authority (the
// caller's profile id is the security segment, server-side), so a Math.random
// fallback is acceptable where Hermes has no crypto global — but the SHAPE must
// always pass the route's regex or every mobile attachment 400s.
describe('draftUuid', () => {
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('mints a v4-shaped uuid the route accepts', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(draftUuid()).toMatch(UUID_SHAPE)
    }
  })

  it('mints a different id per call — two files must never share a draft slot', () => {
    expect(draftUuid()).not.toBe(draftUuid())
  })

  // Hermes ships NO crypto global, so on a real phone the fallback paths are
  // the ONLY paths — vitest's Node has crypto.randomUUID, which would leave
  // them dead code in every test without these stubs.
  it('builds a correct v4 uuid from crypto.getRandomValues when randomUUID is missing', () => {
    const getRandomValues = vi.fn((arr) => {
      // Fixed bytes chosen to catch padding (0x05 → "05"), the version nibble
      // (0xff at byte 6 must become 0x4f) and the variant nibble (0xff at
      // byte 8 must become 0xbf).
      arr.set([0x05, 0x00, 0xff, 0x10, 0x22, 0x33, 0xff, 0x44, 0xff, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb])
      return arr
    })
    vi.stubGlobal('crypto', { getRandomValues })
    try {
      expect(draftUuid()).toBe('0500ff10-2233-4f44-bf55-66778899aabb')
      expect(getRandomValues).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still mints valid, distinct v4-shaped uuids with no crypto at all (the Hermes floor)', () => {
    vi.stubGlobal('crypto', undefined)
    try {
      const seen = new Set()
      for (let i = 0; i < 20; i += 1) {
        const id = draftUuid()
        expect(id).toMatch(UUID_SHAPE)
        seen.add(id)
      }
      expect(seen.size).toBe(20)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// MOBILE-MAIL-A.1 — step 1 of the direct-to-storage flow (the bytes never ride
// an /api body: Vercel 413s over ~4.5MB before any route runs).
describe('signOutboundAttachment', () => {
  it('signs against a mailbox for a new email and returns { path, token, draft }', async () => {
    api.mockResolvedValue({ success: true, data: { path: 'outbound/p/d/0.pdf', token: 'tok-1' } })
    const res = await signOutboundAttachment({
      filename: 'a.pdf', size: 1234, mime: 'application/pdf',
      mailboxId: 'mb-1', locationId: 'loc-1',
    })
    expect(api).toHaveBeenCalledTimes(1)
    const [path, opts] = api.mock.calls[0]
    expect(path).toBe('/api/email/attachments/upload-sign')
    expect(opts.method).toBe('POST')
    expect(opts.locationId).toBe('loc-1')
    expect(opts.body.mailbox_id).toBe('mb-1')
    expect(opts.body.ticket_id).toBeUndefined()
    expect(opts.body.filename).toBe('a.pdf')
    expect(opts.body.mime).toBe('application/pdf')
    expect(opts.body.size).toBe(1234)
    expect(opts.body.index).toBe(0)
    expect(opts.body.draft_id).toMatch(/^[0-9a-fA-F-]{36}$/)
    expect(res.success).toBe(true)
    expect(res.path).toBe('outbound/p/d/0.pdf')
    expect(res.token).toBe('tok-1')
    // The draft ref is EXACTLY what the send body will carry.
    expect(res.draft).toEqual({
      draft_id: opts.body.draft_id, index: 0, filename: 'a.pdf', mime: 'application/pdf',
    })
  })

  it('signs against a ticket for a reply — ticket_id on the wire, no mailbox_id', async () => {
    api.mockResolvedValue({ success: true, data: { path: 'p', token: 't' } })
    await signOutboundAttachment({
      filename: 'a.pdf', size: 10, mime: 'application/pdf',
      ticketId: 'T-1', locationId: 'loc-1',
    })
    const [, opts] = api.mock.calls[0]
    expect(opts.body.ticket_id).toBe('T-1')
    expect(opts.body.mailbox_id).toBeUndefined()
  })

  it('refuses locally when BOTH or NEITHER target is given — the route 400s the same rule', async () => {
    const both = await signOutboundAttachment({
      filename: 'a.pdf', size: 10, mime: 'application/pdf',
      ticketId: 'T-1', mailboxId: 'mb-1', locationId: 'loc-1',
    })
    const neither = await signOutboundAttachment({
      filename: 'a.pdf', size: 10, mime: 'application/pdf', locationId: 'loc-1',
    })
    expect(both.success).toBe(false)
    expect(neither.success).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })

  it('falls back to application/octet-stream when the picker reports no MIME', async () => {
    api.mockResolvedValue({ success: true, data: { path: 'p', token: 't' } })
    const res = await signOutboundAttachment({
      filename: 'mystery.bin', size: 10, mailboxId: 'mb-1', locationId: 'loc-1',
    })
    const [, opts] = api.mock.calls[0]
    expect(opts.body.mime).toBe('application/octet-stream')
    expect(res.draft.mime).toBe('application/octet-stream')
  })

  it('honours a caller-supplied draftId + index (one composer session, monotonic slots)', async () => {
    api.mockResolvedValue({ success: true, data: { path: 'p', token: 't' } })
    const res = await signOutboundAttachment({
      filename: 'a.pdf', size: 10, mime: 'application/pdf',
      mailboxId: 'mb-1', locationId: 'loc-1',
      draftId: '00000000-0000-4000-8000-000000000001', index: 3,
    })
    const [, opts] = api.mock.calls[0]
    expect(opts.body.draft_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(opts.body.index).toBe(3)
    expect(res.draft.index).toBe(3)
  })

  it('surfaces the route refusal — its sentence names the limit', async () => {
    api.mockResolvedValue({ success: false, error: 'big.pdf is 9 MB — one email can carry 7 MB.' })
    const res = await signOutboundAttachment({
      filename: 'big.pdf', size: 9000000, mime: 'application/pdf',
      mailboxId: 'mb-1', locationId: 'loc-1',
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('big.pdf is 9 MB — one email can carry 7 MB.')
  })

  it('treats a success with no token or path as a failure — nothing can be uploaded with half a grant', async () => {
    for (const data of [{ path: 'p' }, { token: 't' }, {}]) {
      api.mockResolvedValue({ success: true, data })
      const res = await signOutboundAttachment({
        filename: 'a.pdf', size: 10, mime: 'application/pdf',
        mailboxId: 'mb-1', locationId: 'loc-1',
      })
      expect(res.success).toBe(false)
    }
  })
})

// Step 2 — the bytes, device → bucket directly, authorised by the token alone.
describe('uploadSignedAttachment', () => {
  function storageMock(uploadResult) {
    const uploadToSignedUrl = vi.fn().mockResolvedValue(uploadResult)
    supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
    return uploadToSignedUrl
  }

  const signed = {
    path: 'outbound/p/d/0.pdf',
    token: 'tok-1',
    draft: { draft_id: 'd-1', index: 0, filename: 'a.pdf', mime: 'application/pdf' },
  }

  it('reads the real bytes and uploads them, returning the draft ref for the send body', async () => {
    const buf = new ArrayBuffer(8)
    readFileAsArrayBuffer.mockResolvedValue(buf)
    const upload = storageMock({ error: null })

    const res = await uploadSignedAttachment(signed, 'file:///tmp/a.pdf')

    expect(readFileAsArrayBuffer).toHaveBeenCalledWith('file:///tmp/a.pdf')
    expect(supabase.storage.from).toHaveBeenCalledWith(EMAIL_ATTACHMENT_BUCKET)
    expect(upload).toHaveBeenCalledWith('outbound/p/d/0.pdf', 'tok-1', buf, {
      contentType: 'application/pdf',
    })
    expect(res).toEqual({ success: true, draft: signed.draft })
  })

  it('refuses an empty read — a 0-byte object would be "sent" as a blank file', async () => {
    readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(0))
    const upload = storageMock({ error: null })
    const res = await uploadSignedAttachment(signed, 'file:///tmp/a.pdf')
    expect(res.success).toBe(false)
    expect(upload).not.toHaveBeenCalled()
  })

  it('surfaces a read failure as a failure, not a throw', async () => {
    readFileAsArrayBuffer.mockRejectedValue(new Error('gone'))
    storageMock({ error: null })
    const res = await uploadSignedAttachment(signed, 'file:///tmp/a.pdf')
    expect(res.success).toBe(false)
    expect(res.error).toContain('gone')
  })

  it('surfaces a storage refusal as a failure', async () => {
    readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(8))
    storageMock({ error: { message: 'expired token' } })
    const res = await uploadSignedAttachment(signed, 'file:///tmp/a.pdf')
    expect(res.success).toBe(false)
    expect(res.error).toContain('expired token')
  })

  it('refuses a malformed signed grant without touching the file or the bucket', async () => {
    // Each case is missing exactly one leg, so each guard clause is what
    // refuses it.
    const cases = [
      { token: 't', draft: signed.draft },       // no path
      { path: 'p', draft: signed.draft },        // no token
      { path: 'p', token: 't' },                 // no draft
      undefined,
    ]
    for (const bad of cases) {
      const res = await uploadSignedAttachment(bad, 'file:///tmp/a.pdf')
      expect(res.success).toBe(false)
    }
    expect(readFileAsArrayBuffer).not.toHaveBeenCalled()
    expect(supabase.storage.from).not.toHaveBeenCalled()
  })
})

// The two ceilings C and D size against — pinned to the server's own values
// (src/lib/email-outbound-attachments.js), which mobile cannot import.
describe('outbound attachment limits', () => {
  it('mirrors the server ceilings exactly', () => {
    expect(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES).toBe(7 * 1024 * 1024)
    expect(MAX_OUTBOUND_ATTACHMENTS).toBe(10)
    expect(EMAIL_ATTACHMENT_BUCKET).toBe('email-attachments')
  })
})
