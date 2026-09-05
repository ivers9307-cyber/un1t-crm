// MAIL-GDPR.1 — contact erasure scrubs mail.
//
// The mail FKs are ON DELETE SET NULL (email_tickets.contact_id, mig 482;
// email_inbox_messages.contact_id, mig 394), so before this a contact delete
// left every ticket, message body and attachment behind with the person's
// name, address and mail intact — orphaned PII nothing could find again once
// the FK nulled. These tests pin the scrub to the SAME doctrine the WhatsApp
// scrub already follows (redactWhatsAppForContact): rows anonymised in place,
// thread skeleton kept, every table attempted even when one fails, failures
// REPORTED to the caller rather than swallowed.
//
// The fake is the mail area's own service-role double (_test-db), which
// applies filters and writes for real — so "the row now reads [redacted]" is
// asserted against state, not against a recorded call.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { makeDb, updatesTo, deletesFrom, objectKeys, seedObject, usageFor, failWrites } from '@/app/api/email/tickets/_test-db'
import {
  redactMailForContact,
  MAIL_REDACTED_EMAIL,
  MAIL_REDACTED_BODY,
  MAIL_TICKET_REDACTION,
  MAIL_MESSAGE_REDACTION,
} from './contact-mail-erasure'
import { EMAIL_ATTACHMENT_BUCKET } from './email-attachment-quota'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const MAILBOX = 'b0000000-0000-4000-8000-000000000002'
const CONTACT = 'c0000000-0000-4000-8000-00000000c001'
const OTHER = 'c0000000-0000-4000-8000-00000000c002'

function ticket(id, overrides = {}) {
  return {
    id, location_id: LOC, mailbox_id: MAILBOX, contact_id: CONTACT,
    requester_email: 'alice@example.com', requester_name: 'Alice Member',
    subject: 'My membership', status: 'open', last_message_preview: 'Hi, about my bill…',
    excluded_participants: ['alice.work@example.com'], created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

function message(id, ticketId, overrides = {}) {
  return {
    id, ticket_id: ticketId, contact_id: CONTACT, location_id: LOC, direction: 'inbound',
    from_email: 'alice@example.com', to_email: 'studio@un1t.ie', to_emails: ['studio@un1t.ie'],
    cc_emails: ['bob@example.com'], bcc_emails: [], subject: 'My membership',
    text_body: 'Hi, about my bill…', html_body: '<p>Hi, about my bill…</p>',
    delivery_detail: null, rfc_message_id: '<abc@mail.example.com>', sent_at: '2026-08-01T10:00:00Z',
    created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

function attachment(id, messageId, overrides = {}) {
  return {
    id, message_id: messageId, location_id: LOC, mailbox_id: MAILBOX,
    storage_path: `${LOC}/${messageId}/${id}.pdf`, filename: 'passport-scan.pdf',
    mime_type: 'application/pdf', size_bytes: 1000, skipped_reason: null,
    forwarded_from_id: null, attachment_index: 0, created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

function seed(db, rows) {
  for (const a of rows.attachments || []) {
    if (a.storage_path && !a.forwarded_from_id) seedObject(db, EMAIL_ATTACHMENT_BUCKET, a.storage_path, 'bytes')
  }
  db._state.tickets.push(...(rows.tickets || []))
  db._state.messages.push(...(rows.messages || []))
  db._state.attachments.push(...(rows.attachments || []))
  if (rows.usage) db._state.storageUsage.push(...rows.usage)
}

let db
let errorSpy
beforeEach(() => {
  db = makeDb()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errorSpy.mockRestore() })

describe('redactMailForContact — the WhatsApp doctrine, applied to mail', () => {
  it('anonymises the contact\'s tickets in place and leaves the thread skeleton', async () => {
    seed(db, { tickets: [ticket('t1'), ticket('t2', { contact_id: OTHER, requester_email: 'other@example.com' })] })

    const out = await redactMailForContact(db, CONTACT)

    const t1 = db._state.tickets.find(t => t.id === 't1')
    expect(t1).toMatchObject(MAIL_TICKET_REDACTION)
    expect(t1.requester_email).toBe(MAIL_REDACTED_EMAIL)
    expect(t1.requester_name).toBeNull()
    expect(t1.excluded_participants).toEqual([])
    // Operator-side audit survives, exactly as the WhatsApp scrub keeps timestamps.
    expect(t1.created_at).toBe('2026-08-01T10:00:00Z')
    // MAIL-GDPR.2 — the thread is filed away, not left open under a sentinel address.
    expect(t1.status).toBe('closed')
    // Another person's ticket is untouched — redaction AND archive. Drop the
    // archive UPDATE's contact_id filter and this is the line that fails.
    const t2 = db._state.tickets.find(t => t.id === 't2')
    expect(t2.requester_email).toBe('other@example.com')
    expect(t2.status).toBe('open')
    expect(t2.closed_at ?? null).toBeNull()
    expect(out.failures).toEqual([])
    expect(out.tickets).toBe(1)
  })

  // ── MAIL-GDPR.2: the redacted conversation is ARCHIVED ────────────────
  // A redacted ticket left `open` sat in Inbox / Needs reply showing
  // redacted@erased.invalid, and a staff reply to it bounced. Archive on the
  // Mail surface IS status='closed' plus the stamps statusTimestamps() writes
  // (mail/[id]/archive/route.js); the scrub mirrors that write exactly, so an
  // erased ticket is indistinguishable from any other archived one.

  it('archives a redacted OPEN ticket with the same stamps the archive route writes', async () => {
    seed(db, { tickets: [ticket('t1', { closed_at: null, solved_at: null, updated_at: '2026-08-01T10:00:00Z' })] })
    const before = Date.now()

    const out = await redactMailForContact(db, CONTACT)

    const t1 = db._state.tickets.find(t => t.id === 't1')
    expect(t1.status).toBe('closed')
    expect(t1.closed_at).toEqual(expect.any(String))
    expect(Date.parse(t1.closed_at)).toBeGreaterThanOrEqual(before)
    expect(t1.updated_at).toBe(t1.closed_at)
    // statusTimestamps('closed') keeps solved_at as it was — never invents one.
    expect(t1.solved_at).toBeNull()
    // Redaction and archive both landed on the one row.
    expect(t1.requester_email).toBe(MAIL_REDACTED_EMAIL)
    expect(out.failures).toEqual([])
  })

  it('a `solved` ticket is archived too and keeps its solved_at, like the route does', async () => {
    seed(db, { tickets: [ticket('t1', { status: 'solved', solved_at: '2026-08-02T09:00:00Z', closed_at: null })] })
    await redactMailForContact(db, CONTACT)
    const t1 = db._state.tickets.find(t => t.id === 't1')
    expect(t1.status).toBe('closed')
    expect(t1.solved_at).toBe('2026-08-02T09:00:00Z')
    expect(t1.closed_at).toEqual(expect.any(String))
  })

  it('an already-closed ticket keeps its original closed_at — history is not rewritten', async () => {
    seed(db, {
      tickets: [
        ticket('t1', { status: 'closed', closed_at: '2026-08-03T08:00:00Z', updated_at: '2026-08-03T08:00:00Z' }),
        ticket('t2'),
      ],
    })

    const out = await redactMailForContact(db, CONTACT)

    const t1 = db._state.tickets.find(t => t.id === 't1')
    expect(t1.status).toBe('closed')
    expect(t1.closed_at).toBe('2026-08-03T08:00:00Z')
    expect(t1.updated_at).toBe('2026-08-03T08:00:00Z')
    // It is still redacted — the archive filter narrows the ARCHIVE write only.
    expect(t1.requester_email).toBe(MAIL_REDACTED_EMAIL)
    // The open sibling is archived.
    const t2 = db._state.tickets.find(t => t.id === 't2')
    expect(t2.status).toBe('closed')
    expect(t2.closed_at).toEqual(expect.any(String))
    expect(out.failures).toEqual([])
  })

  it('a failed ARCHIVE write is a scrub warning, and the redaction + message passes still land', async () => {
    seed(db, { tickets: [ticket('t1')], messages: [message('m1', 't1')] })
    // Fail only the archive UPDATE (the one that writes status), leaving the
    // redaction UPDATE on the same table alone — failWrites cannot tell them apart.
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'email_tickets') return b
      const origUpdate = b.update
      b.update = (payload) => {
        origUpdate(payload)
        if (payload.status === 'closed') {
          const failure = { data: null, error: { code: 'XX000', message: 'archive exploded' } }
          b.then = (res, rej) => Promise.resolve(failure).then(res, rej)
        }
        return b
      }
      return b
    }

    const out = await redactMailForContact(db, CONTACT)

    expect(out.ok).toBe(false)
    expect(out.failures).toEqual([
      expect.objectContaining({ table: 'email_tickets', op: 'update', message: expect.stringMatching(/archive exploded/) }),
    ])
    const t1 = db._state.tickets.find(t => t.id === 't1')
    expect(t1.status).toBe('open')
    expect(t1.requester_email).toBe(MAIL_REDACTED_EMAIL)
    expect(db._state.messages[0].text_body).toBe(MAIL_REDACTED_BODY)
  })

  it('anonymises every message on the contact\'s tickets — including rows never stamped with contact_id', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [
        message('m1', 't1'),
        // An outbound staff reply filed before link-contact backfilled contact_id.
        message('m2', 't1', { contact_id: null, direction: 'outbound', from_email: 'coach@un1t.ie', to_email: 'alice@example.com', text_body: 'Sure, here is your invoice' }),
        // Someone else's mail on a different ticket — must survive.
        message('m3', 'tX', { contact_id: OTHER, from_email: 'other@example.com', text_body: 'unrelated' }),
      ],
    })

    const out = await redactMailForContact(db, CONTACT)

    for (const id of ['m1', 'm2']) {
      const m = db._state.messages.find(x => x.id === id)
      expect(m).toMatchObject(MAIL_MESSAGE_REDACTION)
      expect(m.text_body).toBe(MAIL_REDACTED_BODY)
      expect(m.html_body).toBeNull()
      expect(m.from_email).toBeNull()
      expect(m.to_email).toBeNull()
      expect(m.cc_emails).toEqual([])
    }
    // Skeleton kept: direction + timestamps + threading ids are operator-side audit.
    expect(db._state.messages.find(x => x.id === 'm2').direction).toBe('outbound')
    expect(db._state.messages.find(x => x.id === 'm1').sent_at).toBe('2026-08-01T10:00:00Z')
    expect(db._state.messages.find(x => x.id === 'm1').rfc_message_id).toBe('<abc@mail.example.com>')
    expect(db._state.messages.find(x => x.id === 'm3').text_body).toBe('unrelated')
    expect(out.messages).toBe(2)
  })

  it('also catches a message stamped with contact_id whose ticket is not the contact\'s', async () => {
    // Denormalised contact_id is written by the inbound webhook; a ticket re-linked
    // to another person can leave such a row. Redact by contact_id AND by ticket.
    seed(db, { tickets: [], messages: [message('m9', 'tZ')] })
    await redactMailForContact(db, CONTACT)
    expect(db._state.messages.find(x => x.id === 'm9').text_body).toBe(MAIL_REDACTED_BODY)
  })

  it('also catches messages MERGED off the contact\'s ticket onto someone else\'s — found by neither contact_id nor ticket_id', async () => {
    // The merge route moves messages with { ticket_id: target, merged_from_ticket_id: source }
    // and never touches contact_id; a staff reply filed on a then-unlinked ticket
    // carries contact_id NULL, and link-contact's backfill only looks at
    // .eq('ticket_id', …). So X's message, merged into Y's ticket, is on a
    // ticket that is not X's AND carries no stamp. Only merged_from_ticket_id
    // still says whose it was.
    seed(db, {
      tickets: [ticket('t1'), ticket('tB', { contact_id: OTHER, requester_email: 'other@example.com' })],
      messages: [
        message('m2', 'tB', { contact_id: null, merged_from_ticket_id: 't1', text_body: 'my medical note' }),
        // Y's own message on the surviving ticket — must survive untouched.
        message('mY', 'tB', { contact_id: OTHER, from_email: 'other@example.com', text_body: 'theirs' }),
      ],
      attachments: [attachment('a2', 'm2')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })

    const out = await redactMailForContact(db, CONTACT)

    expect(db._state.messages.find(x => x.id === 'm2').text_body).toBe(MAIL_REDACTED_BODY)
    expect(db._state.messages.find(x => x.id === 'mY').text_body).toBe('theirs')
    // The attachment chain hangs off the message set, so it follows.
    expect(db._state.attachments).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    expect(out.messages).toBe(1)
    expect(out.failures).toEqual([])
  })

  it('removes attachment bytes from storage FIRST, then deletes the rows, then gives the bytes back', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1'), attachment('a2', 'm1', { attachment_index: 1, size_bytes: 500 })],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1500 }],
    })
    expect(objectKeys(db)).toHaveLength(2)

    const out = await redactMailForContact(db, CONTACT)

    expect(objectKeys(db)).toEqual([])
    expect(db._state.attachments).toEqual([])
    expect(deletesFrom(db, 'email_ticket_attachments')).toHaveLength(1)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    expect(out).toMatchObject({ attachments: 2, attachments_deleted: 2, bytes_freed: 1500, failures: [] })
  })

  it('keeps the attachment ROW when the storage delete fails — the object must stay findable', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })
    db._state.storageErrors.remove = { message: 'storage down' }

    const out = await redactMailForContact(db, CONTACT)

    // Row survives, object survives, counter untouched: nothing claims bytes that are still there.
    expect(db._state.attachments).toHaveLength(1)
    expect(objectKeys(db)).toHaveLength(1)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
    expect(out.failures).toEqual([
      expect.objectContaining({ table: 'storage.email-attachments', message: expect.stringMatching(/storage down/) }),
    ])
    // The rest of the scrub still ran — the message body is gone.
    expect(db._state.messages[0].text_body).toBe(MAIL_REDACTED_BODY)
  })

  it('treats an object that is already gone as success', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })
    db._state.storageErrors.remove = { message: 'Object not found' }

    const out = await redactMailForContact(db, CONTACT)

    expect(out.failures).toEqual([])
    expect(db._state.attachments).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
  })

  it('deletes a not-stored attachment row (quota-skipped) without touching storage, and does not decrement for it', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1', { storage_path: null, skipped_reason: 'quota' })],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 0 }],
    })
    const out = await redactMailForContact(db, CONTACT)
    expect(db._state.attachments).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    expect(out).toMatchObject({ attachments_deleted: 1, bytes_freed: 0, failures: [] })
  })

  it('a forwarded copy (mig 501) is deleted but never decremented, and a forward OUTSIDE the set is marked pruned', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1'), message('mF', 't1', { direction: 'outbound' })],
      attachments: [
        attachment('a1', 'm1'),
        // Forward on the contact's own ticket: shares a1's object, was never charged.
        attachment('aF', 'mF', { storage_path: `${LOC}/m1/a1.pdf`, forwarded_from_id: 'a1' }),
        // Forward on SOMEONE ELSE's ticket pointing at a1's bytes — must not 404 silently.
        attachment('aX', 'mOther', { storage_path: `${LOC}/m1/a1.pdf`, forwarded_from_id: 'a1' }),
      ],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })

    const out = await redactMailForContact(db, CONTACT)

    expect(db._state.attachments.map(a => a.id)).toEqual(['aX'])
    expect(db._state.attachments[0]).toMatchObject({ storage_path: null, skipped_reason: 'pruned' })
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    expect(out).toMatchObject({ attachments_deleted: 2, bytes_freed: 1000, failures: [] })
  })

  // ── Review fixes: the three attachment failure paths that had no test ──

  it('a failed mark-forwards UPDATE keeps the owner row — deleting it would fire mig 501\'s SET NULL and promote an outside forward to an owner of nothing', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [
        attachment('a1', 'm1'),
        // Forward on someone else's ticket, sharing a1's bytes.
        attachment('aX', 'mOther', { storage_path: `${LOC}/m1/a1.pdf`, forwarded_from_id: 'a1' }),
      ],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })
    failWrites(db, ['email_ticket_attachments'], ['update'])

    const out = await redactMailForContact(db, CONTACT)

    // The owner row stays for the next run; the forward still points at a live row.
    expect(db._state.attachments.map(a => a.id).sort()).toEqual(['a1', 'aX'])
    expect(db._state.attachments.find(a => a.id === 'aX')).toMatchObject({ forwarded_from_id: 'a1', storage_path: `${LOC}/m1/a1.pdf` })
    // Nothing was deleted, so nothing is given back.
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
    expect(out.attachments_deleted).toBe(0)
    expect(out.bytes_freed).toBe(0)
    expect(out.failures).toEqual([
      expect.objectContaining({ table: 'email_ticket_attachments', op: 'update' }),
    ])
    // The rest of the scrub still ran.
    expect(db._state.messages[0].text_body).toBe(MAIL_REDACTED_BODY)
  })

  it('a failed counter decrement is REPORTED — the bytes and rows are gone, so the mailbox reads fuller than it is', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })
    db._state.errors.add_email_storage_bytes = { message: 'rpc down' }

    const out = await redactMailForContact(db, CONTACT)

    expect(objectKeys(db)).toEqual([])
    expect(db._state.attachments).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
    expect(out.attachments_deleted).toBe(1)
    expect(out.bytes_freed).toBe(0)
    expect(out.failures).toEqual([
      expect.objectContaining({ table: 'email_storage_usage', op: 'rpc', message: expect.stringMatching(/Recalculate/) }),
    ])
  })

  it('a failed row DELETE is reported, and the counter is not decremented for rows that are still there', async () => {
    seed(db, {
      tickets: [ticket('t1')],
      messages: [message('m1', 't1')],
      attachments: [attachment('a1', 'm1')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }],
    })
    failWrites(db, ['email_ticket_attachments'], ['delete'])

    const out = await redactMailForContact(db, CONTACT)

    expect(db._state.attachments).toHaveLength(1)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
    expect(out.attachments_deleted).toBe(0)
    expect(out.bytes_freed).toBe(0)
    expect(out.failures).toEqual([
      expect.objectContaining({ table: 'email_ticket_attachments', op: 'delete' }),
    ])
  })

  it('a contact with no mail is a clean no-op — no writes at all', async () => {
    seed(db, { tickets: [ticket('t2', { contact_id: OTHER })], messages: [message('m3', 't2', { contact_id: OTHER })] })
    const out = await redactMailForContact(db, CONTACT)
    expect(db.updates).toEqual([])
    expect(db.deletes).toEqual([])
    expect(out).toMatchObject({ tickets: 0, messages: 0, attachments: 0, failures: [] })
  })

  it('a failed write is REPORTED, not swallowed — and the other tables are still scrubbed', async () => {
    seed(db, { tickets: [ticket('t1')], messages: [message('m1', 't1')] })
    db._state.errors.email_tickets = { code: '42703', message: 'column "excluded_participants" does not exist' }

    const out = await redactMailForContact(db, CONTACT)

    expect(out.ok).toBe(false)
    expect(out.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'email_tickets', message: expect.stringMatching(/does not exist/) }),
    ]))
    // Loud + structural: logError, not a free-text warn.
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('[contact-mail-erasure]'))).toBe(true)
    // The message pass was still attempted and landed.
    expect(db._state.messages[0].text_body).toBe(MAIL_REDACTED_BODY)
    expect(updatesTo(db, 'email_inbox_messages').length).toBeGreaterThan(0)
  })

  it('a FAILED read still attempts the by-contact write — only a read that found nothing skips it', async () => {
    // errors.<table> fails every operation on that table, so the select and
    // both updates (redact, archive) surface as failures: proof the updates
    // were attempted after the read failed, rather than skipped as if the read
    // had returned zero rows.
    seed(db, { tickets: [ticket('t1')] })
    db._state.errors.email_tickets = { message: 'timeout' }
    const out = await redactMailForContact(db, CONTACT)
    expect(out.failures.filter(f => f.table === 'email_tickets').map(f => f.op).sort()).toEqual(['select', 'update', 'update'])
  })

  it('never throws on a database failure — the caller decides what a partial means', async () => {
    seed(db, { tickets: [ticket('t1')], messages: [message('m1', 't1')] })
    db._state.errors.email_inbox_messages = { message: 'connection reset' }
    await expect(redactMailForContact(db, CONTACT)).resolves.toMatchObject({ ok: false })
  })

  it('refuses a missing contactId (guards a mass wipe)', async () => {
    await expect(redactMailForContact(db, '')).rejects.toThrow(/contactId required/)
    await expect(redactMailForContact(db, null)).rejects.toThrow(/contactId required/)
  })

  it('is idempotent — a second run finds nothing left to change and reports no failures', async () => {
    seed(db, { tickets: [ticket('t1')], messages: [message('m1', 't1')], attachments: [attachment('a1', 'm1')],
      usage: [{ location_id: LOC, mailbox_id: MAILBOX, bytes_used: 1000 }] })
    await redactMailForContact(db, CONTACT)
    const again = await redactMailForContact(db, CONTACT)
    expect(again.failures).toEqual([])
    expect(again.attachments).toBe(0)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
  })

  it('paginates the reads past the 1,000-row PostgREST cap', async () => {
    const msgs = Array.from({ length: 1250 }, (_, i) => message(`m${String(i).padStart(4, '0')}`, 't1'))
    seed(db, { tickets: [ticket('t1')], messages: msgs })
    const out = await redactMailForContact(db, CONTACT)
    expect(out.messages).toBe(1250)
    expect(db._state.messages.every(m => m.text_body === MAIL_REDACTED_BODY)).toBe(true)
  })
})
