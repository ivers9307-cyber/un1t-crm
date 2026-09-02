// EMAIL-FORWARD.1 — the forward path.
//
// Four properties carry the weight, and each has its own block below:
//
//   • BCC NEVER LEAVES THE THREAD. Not as a recipient (the route derives none
//     from stored correspondence) and not in the quoted body (the header block
//     is a closed list of five). Every fixture message here carries a Bcc, and
//     the assertions are on its absence — same mutation-check discipline as
//     email-recipients.test.js and email-forward.test.js.
//   • AN INTERNAL NOTE IS NOT MAIL. A note that reaches Postmark would send
//     staff-only commentary about a member to a third party under the studio's
//     own address. Refused, with nothing sent and nothing written.
//   • THE TICKET DOES NOT MOVE. `needs_reply` is (open AND inbound last
//     message), so a forward that stamped an outbound last message would drop
//     a ticket the member is still waiting on out of the queue.
//   • ATTACHMENTS ARE SHARED, NOT COPIED, AND NEVER SILENTLY DROPPED. The
//     forwarded rows point at the ORIGINAL'S key, carry forwarded_from_id, and
//     an over-budget set is a refusal rather than a truncation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { sendEmail } from '@/lib/postmark'
import { _resetInboxSenderCache, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { EMAIL_ATTACHMENT_BUCKET } from '@/lib/email-attachment-quota'
import { MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES } from '@/lib/email-outbound-attachments'
import {
  makeDb, insertsInto, updatesTo, writesTo, seedObject, objectKeys, usageFor, failWrites,
} from '../../_test-db'
import {
  MB_STUDIO, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION, baseState,
} from '../../_test-fixtures'

function post(id, body) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/forward`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

const SECRET_BCC = ['secret@example.com', 'auditor@example.com']

// The message an operator forwards. It carries a Bcc — every fixture here does,
// because the guarantee under test is that the column is never read.
const INBOUND = {
  id: 'a1111111-0000-4000-8000-000000000001',
  ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
  direction: 'inbound',
  from_email: 'member@example.com',
  to_email: MB_STUDIO.address,
  to_emails: [MB_STUDIO.address],
  cc_emails: ['colleague@example.com'],
  bcc_emails: SECRET_BCC,
  subject: 'Direct debit bounced',
  text_body: 'My payment failed on the 3rd. Bank details attached.',
  html_body: null,
  is_internal_note: false,
  created_at: '2026-08-06T09:00:00Z',
}

const NOTE = {
  id: 'a1111111-0000-4000-8000-000000000002',
  ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
  direction: 'outbound', from_email: COACH.email,
  to_email: null, to_emails: [], cc_emails: [], bcc_emails: [],
  subject: 'Direct debit bounced',
  text_body: 'Heads up — this member has complained twice before. Watch the tone.',
  html_body: null,
  is_internal_note: true,
  created_at: '2026-08-06T09:05:00Z',
}

const OTHER_TICKET_MESSAGE = {
  id: 'a1111111-0000-4000-8000-000000000003',
  ticket_id: T_ACCOUNTS.id, location_id: T_ACCOUNTS.location_id,
  direction: 'inbound', from_email: 'payer@example.com',
  to_email: 'accounts@un1tdublin.com', to_emails: ['accounts@un1tdublin.com'],
  cc_emails: [], bcc_emails: [],
  subject: 'Something else', text_body: 'Different ticket entirely.',
  html_body: null, is_internal_note: false, created_at: '2026-08-06T10:00:00Z',
}

const ATTACH_PATH = `${T_STUDIO.location_id}/${INBOUND.id}/0.pdf`
const ATTACHMENT = {
  id: 'ccccccc1-0000-4000-8000-000000000001',
  message_id: INBOUND.id, location_id: T_STUDIO.location_id, mailbox_id: MB_STUDIO.id,
  attachment_index: 0, filename: 'bank-letter.pdf', mime_type: 'application/pdf',
  size_bytes: 12, storage_path: ATTACH_PATH, skipped_reason: null, forwarded_from_id: null,
  created_at: '2026-08-06T09:00:01Z',
}

// A file the member sent that we never stored — over quota on arrival. It is
// still a row (that is the point), and it must never be forwardable.
const SKIPPED_ATTACHMENT = {
  id: 'ccccccc1-0000-4000-8000-000000000002',
  message_id: INBOUND.id, location_id: T_STUDIO.location_id, mailbox_id: MB_STUDIO.id,
  attachment_index: 1, filename: 'huge-scan.pdf', mime_type: 'application/pdf',
  size_bytes: 30_000_000, storage_path: null, skipped_reason: 'quota', forwarded_from_id: null,
  created_at: '2026-08-06T09:00:02Z',
}

const GOOD = {
  message_id: INBOUND.id,
  to: ['accountant@example.com'],
  note: 'Can you look at this refund?',
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

/** The world every test starts in: one ticket, one forwardable message. */
function world(extra = {}) {
  return baseState({
    grants: [GRANT_STUDIO],
    messages: [{ ...INBOUND }, { ...NOTE }, { ...OTHER_TICKET_MESSAGE }],
    ...extra,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetInboxSenderCache()
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN = 'ticketing-server-token'
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-fwd-1' })
  setupDb(world())
})

afterEach(() => {
  delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
})

const sentPayload = () => sendEmail.mock.calls[0][0]

// ══ GATES ═══════════════════════════════════════════════════════════
describe('POST …/forward — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id, GOOD)).status).toBe(401)
  })

  it('404s on a mailbox the caller has no grant for, and sends nothing', async () => {
    const res = await post(T_ACCOUNTS.id, { ...GOOD, message_id: OTHER_TICKET_MESSAGE.id })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  // The surface key, resolved at the TICKET'S location — the caller holds the
  // grant and the location and is still refused.
  it('404s without email_inbox at the ticket’s location', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    const res = await post(T_STUDIO.id, GOOD)
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s at a studio where the caller lacks the key, even holding the mailbox grant', async () => {
    getCurrentUser.mockResolvedValue(MULTI_LOCATION)
    setupDb(baseState({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }, { ...T_OTHER_LOCATION }],
      grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION],
      messages: [{ ...INBOUND, ticket_id: T_OTHER_LOCATION.id, location_id: T_OTHER_LOCATION.location_id }],
    }))
    const res = await post(T_OTHER_LOCATION.id, GOOD)
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on a body with no recipient at all', async () => {
    const res = await post(T_STUDIO.id, { message_id: INBOUND.id, to: [] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // Scoped to THIS ticket, so an id from another ticket is simply not found —
  // the caller learns nothing about whether it exists.
  it('404s for a message that belongs to another ticket', async () => {
    const res = await post(T_STUDIO.id, { ...GOOD, message_id: OTHER_TICKET_MESSAGE.id })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ══ AN INTERNAL NOTE IS NOT MAIL ════════════════════════════════════
describe('POST …/forward — internal notes cannot be forwarded', () => {
  it('refuses a note with a 400 and sends NOTHING', async () => {
    const res = await post(T_STUDIO.id, { ...GOOD, message_id: NOTE.id })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/internal note/i)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  // The one that matters: the note's TEXT must not reach Postmark by any route.
  it('never puts a note’s staff-only text on the wire', async () => {
    await post(T_STUDIO.id, { ...GOOD, message_id: NOTE.id })
    expect(sendEmail).not.toHaveBeenCalled()
    const everythingSent = JSON.stringify(sendEmail.mock.calls)
    expect(everythingSent).not.toContain('complained twice')
  })
})

// ══ BCC — THE MUTATION CHECK ════════════════════════════════════════
describe('POST …/forward — bcc never leaves the thread it was typed on', () => {
  it('does not put the original’s bcc on the wire as a recipient', async () => {
    await post(T_STUDIO.id, GOOD)
    const payload = sentPayload()
    expect(payload.to).toBe('accountant@example.com')
    // No bcc was typed on THIS forward, so the field is undefined — and the
    // original's two blind copies appear in no field at all.
    expect(payload.bcc).toBeUndefined()
    const wire = JSON.stringify(payload)
    for (const address of SECRET_BCC) expect(wire).not.toContain(address)
  })

  it('does not reproduce the original’s bcc in the QUOTED BODY', async () => {
    await post(T_STUDIO.id, GOOD)
    const { textBody, htmlBody } = sentPayload()
    for (const address of SECRET_BCC) {
      expect(textBody).not.toContain(address)
      expect(htmlBody).not.toContain(address)
    }
    // …while the headers that ARE reproduced really are there, so this is not
    // passing because the quote is empty.
    expect(textBody).toContain('From: member@example.com')
    expect(textBody).toContain('Cc: colleague@example.com')
    expect(textBody).not.toMatch(/bcc/i)
  })

  // The dangerous direction: forwarding a message WE sent, whose bcc_emails we
  // wrote ourselves. This is the row an operator is most likely to forward on.
  it('does not reproduce OUR OWN bcc when forwarding a message we sent', async () => {
    const ourOutbound = {
      ...INBOUND,
      id: 'a1111111-0000-4000-8000-00000000000f',
      direction: 'outbound',
      from_email: MB_STUDIO.address,
      to_emails: ['member@example.com'],
      cc_emails: [],
      bcc_emails: ['legal@example.com'],
      text_body: 'We have refunded you.',
    }
    setupDb(world({ messages: [{ ...INBOUND }, ourOutbound] }))
    await post(T_STUDIO.id, { ...GOOD, message_id: ourOutbound.id })
    const wire = JSON.stringify(sentPayload())
    expect(wire).not.toContain('legal@example.com')
    expect(wire).toContain('member@example.com')
  })

  // A bcc typed on the FORWARD itself is a different thing entirely: it is the
  // sender's own, it goes in Postmark's Bcc field and nowhere else, and it is
  // stored on the forward's own row for the staff thread.
  it('sends a bcc typed on THIS forward in Postmark’s Bcc field and nowhere else', async () => {
    await post(T_STUDIO.id, { ...GOOD, bcc: ['manager@un1tdublin.com'] })
    const payload = sentPayload()
    expect(payload.bcc).toBe('manager@un1tdublin.com')
    expect(payload.to).not.toContain('manager@')
    expect(payload.cc).toBeUndefined()
    expect(JSON.stringify(payload.headers || [])).not.toContain('manager@un1tdublin.com')
    const [row] = insertsInto(db, 'email_inbox_messages')
    expect(row.payload.bcc_emails).toEqual(['manager@un1tdublin.com'])
  })

  // A forward is itself a stored outbound row carrying a bcc_emails we wrote.
  // Forwarding THAT on must not resurrect it — the guarantee has to survive
  // being applied to its own output.
  it('a forward of a forward does not resurrect the first forward’s bcc', async () => {
    const earlierForward = {
      ...INBOUND,
      id: 'a1111111-0000-4000-8000-0000000000e1',
      direction: 'outbound',
      from_email: MB_STUDIO.address,
      to_emails: ['accountant@example.com'],
      cc_emails: [],
      bcc_emails: ['manager@un1tdublin.com'],
      subject: 'Fwd: Direct debit bounced',
      text_body: 'Can you look at this refund?\n\n---------- Forwarded message ----------\nFrom: member@example.com',
      forwarded_message_id: INBOUND.id,
    }
    setupDb(world({ messages: [{ ...INBOUND }, earlierForward] }))

    const res = await post(T_STUDIO.id, { message_id: earlierForward.id, to: ['third@example.com'] })
    expect(res.status).toBe(200)
    const wire = JSON.stringify(sentPayload())
    expect(wire).not.toContain('manager@un1tdublin.com')
    // Still a real quote, so this is not passing vacuously.
    expect(sentPayload().textBody).toContain('accountant@example.com')
    // …and the subject is not double-prefixed.
    expect(sentPayload().subject).toBe('Fwd: Direct debit bounced')
  })
})

// ══ OUR OWN ADDRESSES ═══════════════════════════════════════════════
describe('POST …/forward — our own addresses are excluded', () => {
  // Forwarding to one of our own mailboxes would deliver into the inbound
  // webhook and file a phantom ticket at the same studio.
  it('drops a studio mailbox address typed into To', async () => {
    const res = await post(T_STUDIO.id, {
      ...GOOD, to: ['accountant@example.com', MB_STUDIO.address],
    })
    expect(res.status).toBe(200)
    expect(sentPayload().to).toBe('accountant@example.com')
  })

  it('400s when the ONLY recipient was one of ours, rather than sending to nobody', async () => {
    const res = await post(T_STUDIO.id, { ...GOOD, to: [MB_STUDIO.address] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ══ THE MAIL ITSELF ═════════════════════════════════════════════════
describe('POST …/forward — the mail', () => {
  it('sends on the ticketing server’s transactional stream, from the mailbox', async () => {
    await post(T_STUDIO.id, GOOD)
    const payload = sentPayload()
    expect(payload.stream).toBe(TICKET_INTERNAL_STREAM)
    expect(payload.postmarkStream).toBe('email-send')
    expect(payload.sender.serverToken).toBe('ticketing-server-token')
    expect(payload.sender.fromEmail).toBe(MB_STUDIO.address)
    expect(payload.replyTo).toBe(MB_STUDIO.address)
    expect(payload.tag).toBe('ticket-forward')
  })

  it('prefixes the subject once', async () => {
    await post(T_STUDIO.id, GOOD)
    expect(sentPayload().subject).toBe('Fwd: Direct debit bounced')
  })

  it('puts the note first and the quoted message after the separator', async () => {
    await post(T_STUDIO.id, GOOD)
    const { textBody } = sentPayload()
    expect(textBody.indexOf('Can you look at this refund?'))
      .toBeLessThan(textBody.indexOf('Forwarded message'))
    expect(textBody).toContain('My payment failed on the 3rd')
  })

  it('sends with no note at all', async () => {
    const res = await post(T_STUDIO.id, { message_id: INBOUND.id, to: ['accountant@example.com'] })
    expect(res.status).toBe(200)
    expect(sentPayload().textBody).toContain('Forwarded message')
  })

  it('appends the sender’s signature to the NOTE, above the quoted message', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: 'Sarah\nUN1T Stillorgan' })
    await post(T_STUDIO.id, GOOD)
    const { textBody } = sentPayload()
    expect(textBody).toContain('Sarah\nUN1T Stillorgan')
    expect(textBody.indexOf('Sarah')).toBeLessThan(textBody.indexOf('Forwarded message'))
  })

  it('MAIL-SIG.1 — a rich signature lands BELOW the forward in text, and as the html block', async () => {
    getCurrentUser.mockResolvedValue({
      ...COACH,
      email_signature: 'plain fallback',
      email_signature_rich: { enabled: true, name: 'Garrett Ivers', links: [{ label: 'IG', url: 'https://instagram.com/un1t' }] },
    })
    await post(T_STUDIO.id, GOOD)
    const { textBody, htmlBody } = sentPayload()
    // Gmail's placement: sign-off under the whole forwarded block.
    expect(textBody.indexOf('Garrett Ivers')).toBeGreaterThan(textBody.indexOf('Forwarded message'))
    expect(textBody).not.toContain('plain fallback')
    expect(htmlBody).toContain('href="https://instagram.com/un1t"')
  })

  // No threading headers: In-Reply-To pointing at the member's Message-ID would
  // file our forward inside a thread the recipient has never seen.
  it('carries no threading headers', async () => {
    await post(T_STUDIO.id, GOOD)
    expect(sentPayload().headers).toBeUndefined()
  })

  // THE HOSTILE-HTML ANSWER: the original's markup never becomes markup.
  it('never emits the original’s HTML — the quote is escaped text', async () => {
    const hostile = {
      ...INBOUND,
      id: 'a1111111-0000-4000-8000-0000000000aa',
      text_body: 'Please see <b>attached</b> & confirm',
      html_body: '<img src=x onerror="alert(1)"><style>body{background:url(https://tracker/x)}</style>',
    }
    setupDb(world({ messages: [hostile] }))
    await post(T_STUDIO.id, { ...GOOD, message_id: hostile.id })
    const { htmlBody, textBody } = sentPayload()
    // Nothing from html_body reaches the wire at all.
    expect(htmlBody).not.toContain('onerror')
    expect(htmlBody).not.toContain('<style')
    expect(htmlBody).not.toContain('tracker')
    expect(textBody).not.toContain('onerror')
    // …and the TEXT that is quoted is HTML-escaped, so even markup pasted into
    // a plain-text body cannot become a tag in the message we send.
    expect(htmlBody).toContain('&lt;b&gt;attached&lt;/b&gt;')
    expect(htmlBody).not.toContain('<b>attached</b>')
    // The recipient is told why it looks plain.
    expect(textBody).toMatch(/plain text/i)
  })
})

// ══ WHAT IS WRITTEN ═════════════════════════════════════════════════
describe('POST …/forward — what it writes', () => {
  it('writes ONE outbound message on the SAME ticket, naming what it forwarded', async () => {
    const res = await post(T_STUDIO.id, { ...GOOD, cc: ['bookkeeper@example.com'] })
    expect(res.status).toBe(200)
    const rows = insertsInto(db, 'email_inbox_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({
      ticket_id: T_STUDIO.id,
      direction: 'outbound',
      is_internal_note: false,
      author_profile_id: COACH.id,
      from_email: MB_STUDIO.address,
      to_email: 'accountant@example.com',
      to_emails: ['accountant@example.com'],
      cc_emails: ['bookkeeper@example.com'],
      forwarded_message_id: INBOUND.id,
      postmark_message_id: 'pm-fwd-1',
      status: 'sent',
    })
  })

  // THE ONE THAT KEEPS THE QUEUE HONEST. needs_reply is (open AND inbound last
  // message); an outbound stamp here would drop a ticket the member is still
  // waiting on out of the queue because somebody asked the accountant about it.
  it('does NOT touch the ticket — no status, no last_message, no first_response', async () => {
    await post(T_STUDIO.id, GOOD)
    expect(updatesTo(db, 'email_tickets')).toEqual([])
    const ticket = db._state.tickets.find(t => t.id === T_STUDIO.id)
    expect(ticket.status).toBe('open')
    expect(ticket.last_message_direction).toBe('inbound')
    expect(ticket.first_response_at).toBeNull()
    expect(ticket.last_message_preview).toBe('What time is the 6am?')
  })

  // A forward goes to a THIRD PARTY. An email_sends row against the member's
  // contact_id would put "we emailed you" in their own history for mail they
  // never received.
  it('writes NO email_sends row', async () => {
    await post(T_STUDIO.id, GOOD)
    expect(insertsInto(db, 'email_sends')).toEqual([])
  })

  it('logs the whole recipient set to audit_events under the sender’s name', async () => {
    await post(T_STUDIO.id, { ...GOOD, cc: ['bookkeeper@example.com'] })
    const [audit] = insertsInto(db, 'audit_events')
    expect(audit.payload.action).toBe('email_ticket.forwarded')
    expect(audit.payload.details.added).toEqual(
      expect.arrayContaining(['accountant@example.com', 'bookkeeper@example.com'])
    )
    expect(audit.payload.details.forwarded_message_id).toBe(INBOUND.id)
  })
})

// ══ SEND BEFORE WRITE ═══════════════════════════════════════════════
describe('POST …/forward — a failed send writes nothing', () => {
  it('503s and writes nothing when the ticketing server is unconfigured', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    const res = await post(T_STUDIO.id, GOOD)
    expect(res.status).toBe(503)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('400s and writes nothing when Postmark refuses', async () => {
    sendEmail.mockRejectedValue(Object.assign(new Error('Inactive recipient'), { errorCode: 406 }))
    const res = await post(T_STUDIO.id, GOOD)
    expect(res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  // Nothing has been sent when the lookup blows up, so refusing costs a retry.
  // Forwarding an empty quote under the member's subject line would not.
  it('500s BEFORE sending when the source message cannot be read', async () => {
    setupDb(world({ errors: { email_inbox_messages: { code: '42703', message: 'column gone' } } }))
    const res = await post(T_STUDIO.id, GOOD)
    expect(res.status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ══ ATTACHMENTS ═════════════════════════════════════════════════════
describe('POST …/forward — the files ride along, shared not copied', () => {
  function withAttachment(extra = {}) {
    const state = world({ attachments: [{ ...ATTACHMENT }, { ...SKIPPED_ATTACHMENT }], ...extra })
    setupDb(state)
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, ATTACH_PATH, 'PDF-BYTES-12')
    return db
  }

  it('sends nothing extra when no files are chosen', async () => {
    withAttachment()
    await post(T_STUDIO.id, GOOD)
    // undefined, not [] — so a bare forward's payload is byte-identical to a reply's.
    expect(sentPayload().attachments).toBeUndefined()
    expect(insertsInto(db, 'email_ticket_attachments')).toEqual([])
  })

  it('base64s the ORIGINAL’s bytes onto the Postmark payload', async () => {
    withAttachment()
    await post(T_STUDIO.id, { ...GOOD, attachment_ids: [ATTACHMENT.id] })
    const [file] = sentPayload().attachments
    expect(file.Name).toBe('bank-letter.pdf')
    expect(file.ContentType).toBe('application/pdf')
    expect(Buffer.from(file.Content, 'base64').toString()).toBe('PDF-BYTES-12')
  })

  // THE POINT OF mig 501: one object, two rows. Nothing is copied to a new key.
  it('records a row pointing at the ORIGINAL’s key, marked forwarded_from_id', async () => {
    withAttachment()
    const before = objectKeys(db)
    await post(T_STUDIO.id, { ...GOOD, attachment_ids: [ATTACHMENT.id] })
    const [row] = insertsInto(db, 'email_ticket_attachments')
    expect(row.payload).toMatchObject({
      storage_path: ATTACH_PATH,
      forwarded_from_id: ATTACHMENT.id,
      filename: 'bank-letter.pdf',
      skipped_reason: null,
      attachment_index: 0,
      location_id: T_STUDIO.location_id,
      mailbox_id: MB_STUDIO.id,
    })
    // No second object in the bucket — the whole file was never re-uploaded.
    expect(objectKeys(db)).toEqual(before)
  })

  // FORWARDING A FORWARD — ordinary (the accountant's answer goes on to the
  // bank), and the case that would build a reference CHAIN. The prune's cascade
  // is a single pass, so a chain owner → fwd1 → fwd2 would leave fwd2 pointing
  // at bytes that are already gone. The new row therefore names the OWNER.
  it('points a forward-of-a-forward at the OWNER, never at the reference in front of it', async () => {
    const earlierForward = {
      ...INBOUND,
      id: 'a1111111-0000-4000-8000-0000000000e2',
      direction: 'outbound', from_email: MB_STUDIO.address,
      to_emails: ['accountant@example.com'], cc_emails: [], bcc_emails: [],
      subject: 'Fwd: Direct debit bounced', text_body: 'Passing this on.',
      forwarded_message_id: INBOUND.id,
    }
    // Its attachment row is itself a reference: same object, owner = ATTACHMENT.
    const referenceRow = {
      ...ATTACHMENT,
      id: 'ccccccc1-0000-4000-8000-0000000000e2',
      message_id: earlierForward.id,
      forwarded_from_id: ATTACHMENT.id,
    }
    setupDb(world({ messages: [{ ...INBOUND }, earlierForward], attachments: [{ ...ATTACHMENT }, referenceRow] }))
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, ATTACH_PATH, 'PDF-BYTES-12')

    const res = await post(T_STUDIO.id, {
      message_id: earlierForward.id,
      to: ['bank@example.com'],
      attachment_ids: [referenceRow.id],
    })
    expect(res.status).toBe(200)
    const [row] = insertsInto(db, 'email_ticket_attachments')
    // The OWNER, not referenceRow.id — the graph stays exactly one level deep.
    expect(row.payload.forwarded_from_id).toBe(ATTACHMENT.id)
    expect(row.payload.storage_path).toBe(ATTACH_PATH)
  })

  // No new bytes exist, so no new bytes are billed.
  it('charges the mailbox quota nothing for a forwarded copy', async () => {
    withAttachment()
    await post(T_STUDIO.id, { ...GOOD, attachment_ids: [ATTACHMENT.id] })
    expect(db.rpcs.filter(r => r.fn === 'add_email_storage_bytes')).toEqual([])
    expect(usageFor(db, T_STUDIO.location_id, MB_STUDIO.id)).toBeNull()
  })

  // …and the repair tool agrees with the write path, which is the failure mode
  // that would otherwise be invisible until a mailbox read as full.
  it('is not double-counted by a later recalculate', async () => {
    withAttachment({
      storageUsage: [{
        id: 'u1', location_id: T_STUDIO.location_id, mailbox_id: MB_STUDIO.id,
        bytes_used: 12, quota_bytes: 5368709120,
      }],
    })
    await post(T_STUDIO.id, { ...GOOD, attachment_ids: [ATTACHMENT.id] })
    await db.rpc('recalc_email_storage_usage', { p_location_id: T_STUDIO.location_id })
    expect(usageFor(db, T_STUDIO.location_id, MB_STUDIO.id).bytes_used).toBe(12)
  })

  // A row with no bytes is still a row — it must never be offered, and asking
  // for it is refused with a sentence that names it.
  it('REFUSES a file whose bytes were never stored, and sends nothing', async () => {
    withAttachment()
    const res = await post(T_STUDIO.id, { ...GOOD, attachment_ids: [SKIPPED_ATTACHMENT.id] })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain('huge-scan.pdf')
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES an attachment id from a different message', async () => {
    withAttachment({
      attachments: [
        { ...ATTACHMENT },
        { ...ATTACHMENT, id: 'ccccccc1-0000-4000-8000-0000000000ff', message_id: OTHER_TICKET_MESSAGE.id },
      ],
    })
    const res = await post(T_STUDIO.id, {
      ...GOOD, attachment_ids: ['ccccccc1-0000-4000-8000-0000000000ff'],
    })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // The object was pruned between the page load and the send. Nothing is sent —
  // a forward missing the invoice the operator ticked is the silent drop this
  // whole design refuses.
  it('REFUSES when the shared object is no longer in the bucket', async () => {
    setupDb(world({ attachments: [{ ...ATTACHMENT }] }))
    // deliberately NOT seeded
    const res = await post(T_STUDIO.id, { ...GOOD, attachment_ids: [ATTACHMENT.id] })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/could not be read/i)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  // THE CAP. An inbound email can legitimately carry more than we may forward
  // (25 MB in, 7 MiB out). The refusal names both numbers so it is not retried
  // unchanged — and nothing is silently left behind.
  it('REFUSES a set past Postmark’s ceiling, naming the limit, with nothing sent', async () => {
    const bigPath = `${T_STUDIO.location_id}/${INBOUND.id}/2.pdf`
    const big = {
      ...ATTACHMENT,
      id: 'ccccccc1-0000-4000-8000-0000000000bb',
      attachment_index: 2, filename: 'scan.pdf',
      size_bytes: MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES + 1,
      storage_path: bigPath,
    }
    setupDb(world({ attachments: [big] }))
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, bigPath,
      Buffer.alloc(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES + 1, 0x41))
    const res = await post(T_STUDIO.id, { ...GOOD, attachment_ids: [big.id] })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain('7.0 MB')
    expect(body.error).toMatch(/untick/i)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  // The TRUE downloaded length decides, not the size_bytes we stored months ago.
  it('judges the ceiling on the downloaded bytes, not the stored size_bytes', async () => {
    const lyingPath = `${T_STUDIO.location_id}/${INBOUND.id}/3.pdf`
    const lying = {
      ...ATTACHMENT,
      id: 'ccccccc1-0000-4000-8000-0000000000cc',
      attachment_index: 3, filename: 'lying.pdf',
      size_bytes: 10, // the row claims 10 bytes…
      storage_path: lyingPath,
    }
    setupDb(world({ attachments: [lying] }))
    // …the object is over the ceiling.
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, lyingPath,
      Buffer.alloc(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES + 1, 0x41))
    const res = await post(T_STUDIO.id, { ...GOOD, attachment_ids: [lying.id] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ── The forward's own sent-but-unfiled branch (EMAIL-COMPOSE-UNFILED.1) ──
//
// The branch shipped with the right COPY from day one; what it lacked was the
// machine-readable `data.sent` flag the reply route carries (so the client can
// tell this 500 from every other) and any durable record of the delivered
// send — the message row that failed to write was the only thing that would
// ever have referenced it. `failWrites` is the shared write-only-failure
// harness (../../_test-db.js).
describe('POST …/forward — filing fails AFTER the send', () => {
  let errors
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => errors.mockRestore())

  it('answers with the flag and dead-letters the delivered forward', async () => {
    setupDb(world())
    failWrites(db, ['email_inbox_messages'])
    const res = await post(T_STUDIO.id, GOOD)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/was sent/i)
    expect(body.error).toMatch(/do not resend/i)
    expect(body.error).not.toContain('write exploded')
    expect(body.data).toMatchObject({ sent: true, message_id: 'pm-fwd-1' })
    expect(sendEmail).toHaveBeenCalledTimes(1)

    const [dead] = insertsInto(db, 'webhook_dead_letter')
    expect(dead.payload).toMatchObject({
      provider: 'email_ticket_forward',
      event_type: 'sent_not_filed',
      location_id: T_STUDIO.location_id,
    })
    // Enough to reconstruct the row by hand — including WHAT was forwarded,
    // which is the one fact a forward adds over a reply.
    expect(dead.payload.payload).toMatchObject({
      ticket_id: T_STUDIO.id,
      forwarded_message_id: INBOUND.id,
      postmark_message_id: 'pm-fwd-1',
    })
    expect(dead.payload.payload.recipients.to).toEqual(['accountant@example.com'])
    // The quoted body went to a third party; the record of what they received
    // has to be the SENT text, note and quote included.
    expect(dead.payload.payload.text_body).toContain(GOOD.note)
    expect(dead.payload.payload.text_body).toContain(INBOUND.text_body)
  })

  it('still refuses to touch the ticket — an unfiled forward moves nothing either', async () => {
    setupDb(world())
    failWrites(db, ['email_inbox_messages'])
    await post(T_STUDIO.id, GOOD)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
  })
})

// EMAIL-MERGE.6 — nothing leaves a tombstone.
//
// Same rule as the reply route, and it belongs here for a sharper reason: a
// forward takes what the MEMBER sent us and hands it to a third party. Doing
// that from a ticket scopeToUnmerged hides means the member's correspondence
// goes to an outsider from a thread nobody is watching, with no row anywhere a
// colleague would find. The messages themselves have already moved to the
// survivor — forwarding one belongs there.
//
// The route is the gate: this runs on the service-role client, so the
// composer being hidden on the web protects only the web. The mobile app has
// no concept of merge at all.
describe('a merged ticket cannot be forwarded from', () => {
  it('refuses with 409 and names the survivor — and SENDS NOTHING', async () => {
    setupDb(world({ tickets: [{ ...T_STUDIO, merged_into_id: T_ACCOUNTS.id, status: 'closed' }, { ...T_ACCOUNTS }] }))

    const res = await post(T_STUDIO.id, GOOD)

    // 409 rather than the 404 the other refusals here use: the caller got past
    // loadTicketForUser, so the ticket is one they can see and the reason is
    // one they are owed.
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/merged into another one/i)
    expect(body.data.merged_into_id).toBe(T_ACCOUNTS.id)

    // THE HALF THAT MATTERS: the member's message never reached the third
    // party. A refusal that still sent would be the whole harm, annotated.
    expect(sendEmail).not.toHaveBeenCalled()
    // The route sends before it writes, so a refusal at the gate leaves
    // nothing behind — no message row, no attachment copy, no usage.
    expect(writesTo(db)).toEqual([])
  })

  it('still forwards normally on an ordinary ticket', async () => {
    // The negative half — a guard that refused everything would pass the test
    // above while quietly breaking forwarding.
    const res = await post(T_STUDIO.id, GOOD)
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })
})
