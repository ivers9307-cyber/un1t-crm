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

import { api } from './api'
import { getTicket, getMailCount, listMail, archiveConversation, setConversationSeen } from './email-api'

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
