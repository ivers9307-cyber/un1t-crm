import { describe, it, expect, vi } from 'vitest'
import { fetchAllRows, MAX_ROWS_PER_SECTION } from './contact-export.js'

function pagedDb(totalRows) {
  // A stub whose .range(from, to) slices a synthetic row set, mimicking
  // PostgREST's paging so the paginator's loop logic is exercised for real.
  const all = Array.from({ length: totalRows }, (_, i) => ({ id: `r${i}` }))
  const builder = {
    _from: 0,
    _to: 0,
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn((from, to) => {
      builder._from = from
      builder._to = to
      return builder
    }),
    then(resolve) {
      resolve({ data: all.slice(builder._from, builder._to + 1), error: null })
    },
  }
  return { from: vi.fn(() => builder), builder }
}

describe('fetchAllRows (SAAS4-C3 — DSAR export paginator)', () => {
  it('collects every row across pages (beyond the PostgREST 1k cap)', async () => {
    const db = pagedDb(2500)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'email_sends',
      select: 'id',
      eq: { contact_id: 'c1' },
      orderCol: 'id',
    })
    expect(rows).toHaveLength(2500)
    expect(truncated).toBe(false)
  })

  it('stops at MAX_ROWS_PER_SECTION and flags truncation honestly', async () => {
    const db = pagedDb(MAX_ROWS_PER_SECTION + 500)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'whatsapp_messages',
      select: 'id',
      eq: { conversation_id: 'w1' },
      orderCol: 'id',
    })
    expect(rows).toHaveLength(MAX_ROWS_PER_SECTION)
    expect(truncated).toBe(true)
  })

  it('throws on a PostgREST error instead of reading it as "no rows" — a DSAR must never silently omit a section', async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: () => builder,
      then(resolve) {
        resolve({ data: null, error: { message: 'column does not exist' } })
      },
    }
    const db = { from: () => builder }
    await expect(
      fetchAllRows(db, { table: 'x', select: 'nope', eq: { contact_id: 'c1' }, orderCol: 'id' })
    ).rejects.toThrow(/column does not exist/)
  })

  it('returns empty cleanly for a contact with no rows', async () => {
    const db = pagedDb(0)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'notes',
      select: 'id',
      eq: { contact_id: 'c1' },
      orderCol: 'id',
    })
    expect(rows).toEqual([])
    expect(truncated).toBe(false)
  })
})

// DSAR-CONSENT.1 — the bundle read consent_log.action straight off the row
// without going through normaliseConsentAction, so a bundle built from data
// written before mig 516 (or restored from an older dump) shows two spellings
// of one fact: `opted_out` next to `opt_out`.
function exportDb(rowsByTable) {
  function builder(table) {
    const state = { table, from: 0, to: 0 }
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      range: (from, to) => { state.from = from; state.to = to; return b },
      then(resolve) {
        const all = rowsByTable[table] || []
        resolve({ data: all.slice(state.from, state.to + 1), error: null })
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

const CONTACT = { id: 'c1', name: 'Alice M', email: 'a@x.ie', phone: null, created_at: '2026-01-01T00:00:00.000Z', location_id: 'loc-1' }

describe('buildContactExport — consent_log action vocabulary (DSAR-CONSENT.1)', () => {
  it('renders one spelling of each fact, and keeps the stored value visible', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = exportDb({
      consent_log: [
        { channel: 'email_marketing', action: 'opted_out', source: 'whatsapp_stop', created_at: '2026-02-01T00:00:00.000Z' },
        { channel: 'sms_marketing', action: 'opt_out', source: 'preference_centre', created_at: '2026-03-01T00:00:00.000Z' },
        { channel: 'email_marketing', action: 'opted_in', source: 'booking_form', created_at: '2026-04-01T00:00:00.000Z' },
      ],
    })

    const bundle = await buildContactExport(db, CONTACT)
    const rows = bundle.sections.consent_log.rows

    expect(rows.map((r) => r.action)).toEqual(['opt_out', 'opt_out', 'opt_in'])
    // Non-lossy: where the stored value differed it is still in the bundle.
    expect(rows[0].action_raw).toBe('opted_out')
    expect(rows[2].action_raw).toBe('opted_in')
    // Where it did not differ, no redundant field is emitted.
    expect(rows[1]).not.toHaveProperty('action_raw')
  })

  it('passes an unrecognised action through verbatim rather than guessing', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = exportDb({
      consent_log: [{ channel: 'email_marketing', action: 'who_knows', source: 'legacy', created_at: '2026-02-01T00:00:00.000Z' }],
    })

    const bundle = await buildContactExport(db, CONTACT)
    const [row] = bundle.sections.consent_log.rows
    expect(row.action).toBe('who_knows')
    expect(row).not.toHaveProperty('action_raw')
  })
})

// MAIL-GDPR.1 — the bundle omitted mail entirely. A subject access request
// answered without the person's own email correspondence is an incomplete
// answer, so the section is built from the same three tables the erasure
// scrubs: tickets by contact_id, messages by contact_id ∪ ticket, attachments
// by message. Filenames only — never bytes, mirroring the WhatsApp section
// which exports bodies but not media.
// Projects the SELECT list like PostgREST does, so "bcc never leaves the
// database" is asserted against what the query names, not against a fake that
// hands back whole rows.
function mailDb(rowsByTable) {
  function builder(table) {
    const state = { table, from: 0, to: 0, eq: {}, in: null, columns: null }
    const project = (r) => state.columns
      ? Object.fromEntries(state.columns.map(c => [c, r[c]]).filter(([, v]) => v !== undefined))
      : r
    const b = {
      select: (cols) => { state.columns = cols ? cols.split(',').map(c => c.trim()) : null; return b },
      eq: (col, val) => { state.eq[col] = val; return b },
      in: (col, vals) => { state.in = [col, vals]; return b },
      order: () => b,
      range: (from, to) => { state.from = from; state.to = to; return b },
      then(resolve) {
        let all = rowsByTable[table] || []
        for (const [col, val] of Object.entries(state.eq)) all = all.filter(r => (r[col] ?? null) === val)
        if (state.in) all = all.filter(r => state.in[1].includes(r[state.in[0]]))
        resolve({ data: all.slice(state.from, state.to + 1).map(project), error: null })
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

describe('buildContactExport — mail section (MAIL-GDPR.1)', () => {
  it('exports tickets, every message on them (including un-stamped ones), and attachment filenames', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = mailDb({
      email_tickets: [
        { id: 't1', contact_id: 'c1', subject: 'Billing', status: 'solved', requester_email: 'a@x.ie', requester_name: 'Alice M', created_at: '2026-08-01T10:00:00Z', last_message_at: '2026-08-02T10:00:00Z', solved_at: '2026-08-02T11:00:00Z', closed_at: null },
        { id: 't9', contact_id: 'someone-else', subject: 'Nope', status: 'open', requester_email: 'z@x.ie', created_at: '2026-08-01T10:00:00Z' },
      ],
      email_inbox_messages: [
        { id: 'm1', ticket_id: 't1', contact_id: 'c1', direction: 'inbound', from_email: 'a@x.ie', to_email: 'studio@un1t.ie', to_emails: ['studio@un1t.ie'], cc_emails: [], bcc_emails: ['secret@un1t.ie'], subject: 'Billing', text_body: 'Hi', html_body: '<p>Hi</p>', is_internal_note: false, sent_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00Z' },
        // Outbound staff reply filed before link-contact stamped contact_id.
        { id: 'm2', ticket_id: 't1', contact_id: null, direction: 'outbound', from_email: 'coach@un1t.ie', to_email: 'a@x.ie', to_emails: ['a@x.ie'], cc_emails: [], bcc_emails: [], subject: 'Re: Billing', text_body: 'Sorted', html_body: null, is_internal_note: false, sent_at: '2026-08-02T10:00:00Z', created_at: '2026-08-02T10:00:00Z' },
        // Stamped with contact_id but on a ticket that has since been re-linked.
        { id: 'm3', ticket_id: 't7', contact_id: 'c1', direction: 'inbound', from_email: 'a@x.ie', to_email: 'studio@un1t.ie', to_emails: [], cc_emails: [], bcc_emails: [], subject: 'Old', text_body: 'Older mail', html_body: null, is_internal_note: false, sent_at: '2026-07-01T10:00:00Z', created_at: '2026-07-01T10:00:00Z' },
        { id: 'm9', ticket_id: 't9', contact_id: 'someone-else', direction: 'inbound', text_body: 'not yours', created_at: '2026-08-01T10:00:00Z' },
      ],
      email_ticket_attachments: [
        { id: 'a1', message_id: 'm1', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 1000, skipped_reason: null, storage_path: 'loc/m1/0.pdf', created_at: '2026-08-01T10:00:00Z' },
        { id: 'a9', message_id: 'm9', filename: 'theirs.pdf', mime_type: 'application/pdf', size_bytes: 1, skipped_reason: null, storage_path: 'loc/m9/0.pdf', created_at: '2026-08-01T10:00:00Z' },
      ],
    })

    const bundle = await buildContactExport(db, CONTACT)
    const mail = bundle.sections.mail

    expect(mail.tickets.count).toBe(1)
    expect(mail.tickets.rows[0]).toMatchObject({ id: 't1', subject: 'Billing', status: 'solved', requester_email: 'a@x.ie' })

    expect(mail.messages.count).toBe(3)
    expect(mail.messages.rows.map(m => m.id).sort()).toEqual(['m1', 'm2', 'm3'])
    const m1 = mail.messages.rows.find(m => m.id === 'm1')
    expect(m1).toMatchObject({ direction: 'inbound', from_email: 'a@x.ie', subject: 'Billing', text_body: 'Hi' })
    // bcc is audit-only and MUST NEVER reach a member-visible context (mig 482);
    // html_body is markup the inbox itself never renders.
    expect(m1).not.toHaveProperty('bcc_emails')
    expect(m1).not.toHaveProperty('html_body')

    expect(mail.attachments.count).toBe(1)
    expect(mail.attachments.rows[0]).toMatchObject({ message_id: 'm1', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 1000 })
    // Filenames, never the object key or bytes.
    expect(mail.attachments.rows[0]).not.toHaveProperty('storage_path')
    expect(mail.truncated).toBe(false)
  })

  it('includes a message MERGED off the contact\'s ticket onto someone else\'s — the third lookup, same as the scrub', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = mailDb({
      email_tickets: [
        { id: 't1', contact_id: 'c1', subject: 'Billing', status: 'closed', requester_email: 'a@x.ie', created_at: '2026-08-01T10:00:00Z' },
        { id: 'tB', contact_id: 'someone-else', subject: 'Theirs', status: 'open', requester_email: 'z@x.ie', created_at: '2026-08-01T10:00:00Z' },
      ],
      email_inbox_messages: [
        // Moved by the merge route: ticket_id is now tB, contact_id was never stamped.
        { id: 'm4', ticket_id: 'tB', contact_id: null, merged_from_ticket_id: 't1', direction: 'inbound', from_email: 'a@x.ie', text_body: 'moved mail', created_at: '2026-08-03T10:00:00Z' },
        // Their own message on the surviving ticket — not the requester's data.
        { id: 'mB', ticket_id: 'tB', contact_id: 'someone-else', direction: 'inbound', text_body: 'not yours', created_at: '2026-08-01T10:00:00Z' },
      ],
      email_ticket_attachments: [
        { id: 'a4', message_id: 'm4', filename: 'moved.pdf', mime_type: 'application/pdf', size_bytes: 10, skipped_reason: null, created_at: '2026-08-03T10:00:00Z' },
      ],
    })

    const mail = (await buildContactExport(db, CONTACT)).sections.mail
    expect(mail.messages.rows.map(m => m.id)).toEqual(['m4'])
    expect(mail.attachments.rows.map(a => a.filename)).toEqual(['moved.pdf'])
  })

  it('a contact with no mail gets an empty, honest section — not an error marker', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const bundle = await buildContactExport(mailDb({}), CONTACT)
    expect(bundle.sections.mail).toMatchObject({
      tickets: { count: 0, rows: [] },
      messages: { count: 0, rows: [] },
      attachments: { count: 0, rows: [] },
      truncated: false,
    })
  })

  it('a mail read failure yields an explicit error marker, never a silent hole — same posture as the WhatsApp section', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const good = mailDb({})
    const db = {
      from: (table) => table === 'email_tickets'
        ? { select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'relation does not exist' } }) }) }) }) }
        : good.from(table),
    }
    const bundle = await buildContactExport(db, CONTACT)
    expect(bundle.sections.mail).toEqual({ error: 'unavailable' })
  })
})
