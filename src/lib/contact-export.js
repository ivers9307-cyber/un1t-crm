// SAAS4-C3 — subject-access (DSAR) export for one contact (SaaS
// machinery plan §6). The gyms are the controllers answering subject
// access requests; this makes the CRM able to answer them: one JSON
// bundle of everything held about a member, section by section.
//
// Erasure already exists (DELETE /api/contacts/[id] hard-deletes with
// WhatsApp + InBody redaction); this is the missing read side.
//
// Every section .range()-paginates (a chatty contact's WhatsApp
// history exceeds the PostgREST 1k cap) and hard-stops at
// MAX_ROWS_PER_SECTION with an honest `truncated` flag in the bundle
// meta rather than silently dropping rows.

import { normaliseConsentAction } from './consent-actions.js'

export const MAX_ROWS_PER_SECTION = 5000
const PAGE = 1000

/**
 * Fetch every row matching the filters, paginated, bounded.
 * @param {object} db
 * @param {{ table: string, select: string, eq?: Record<string, string>, inFilter?: [string, string[]], orderCol: string }} q
 *   `inFilter` is `[column, values]` — MAIL-GDPR.1 added it for the rows that
 *   hang off a parent set (messages by ticket, attachments by message). Callers
 *   chunk `values`; this function does not.
 * @returns {Promise<{ rows: object[], truncated: boolean }>}
 */
export async function fetchAllRows(db, { table, select, eq = {}, inFilter, orderCol }) {
  const rows = []
  for (let from = 0; rows.length < MAX_ROWS_PER_SECTION; from += PAGE) {
    let query = db.from(table).select(select)
    for (const [col, val] of Object.entries(eq)) query = query.eq(col, val)
    if (inFilter) query = query.in(inFilter[0], inFilter[1])
    const { data, error } = await query.order(orderCol, { ascending: true }).range(from, from + PAGE - 1)
    // supabase-js RESOLVES with an error object — surface it: a DSAR
    // bundle must never silently render a broken section as "no rows".
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return { rows, truncated: false }
  }
  return { rows: rows.slice(0, MAX_ROWS_PER_SECTION), truncated: true }
}

async function section(db, q) {
  const { rows, truncated } = await fetchAllRows(db, q)
  return { count: rows.length, truncated, rows }
}

// PostgREST `in` filters ride on the URL; 200 ids per request is comfortable.
const IN_CHUNK = 200

/**
 * Rows whose `inCol` is in `values`, chunked so the URL stays short, merged
 * and bounded like any other section. Rows are deduped by `id` because the
 * mail section unions two lookups (by contact_id and by ticket) that overlap.
 */
async function fetchAllRowsIn(db, { table, select, inCol, values, orderCol }) {
  const byId = new Map()
  let truncated = false
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK)
    const page = await fetchAllRows(db, { table, select, inFilter: [inCol, chunk], orderCol })
    for (const r of page.rows) byId.set(r.id, r)
    truncated = truncated || page.truncated
  }
  const rows = [...byId.values()]
  if (rows.length > MAX_ROWS_PER_SECTION) return { rows: rows.slice(0, MAX_ROWS_PER_SECTION), truncated: true }
  return { rows, truncated }
}

// MAIL-GDPR.1 — the mail section. The bundle had no mail at all, so a subject
// access request was answered without the person's own correspondence.
//
// Tickets by contact_id. Messages by contact_id (the denormalised stamp the
// webhook writes) UNION by ticket_id — an outbound staff reply filed before
// link-contact backfilled the stamp carries contact_id NULL, and a message
// stamped with the contact can sit on a ticket since re-linked to someone
// else — UNION by merged_from_ticket_id: the merge route moves a source
// ticket's messages onto the target without ever writing contact_id, so a
// merged-away message is on a ticket that is not the contact's and carries no
// stamp. Same three lookups the erasure scrub uses, so what is exported is
// what would be erased. Attachments by message_id: FILENAMES ONLY — the WhatsApp
// section exports bodies but never media bytes, and this mirrors it. Two
// columns are deliberately left out: bcc_emails (audit-only per mig 482,
// "MUST NEVER be rendered in any member-visible context") and html_body
// (markup the inbox itself never renders; text_body is the content).
const MAIL_TICKET_COLUMNS = 'id, subject, status, requester_email, requester_name, created_at, last_message_at, solved_at, closed_at'
const MAIL_MESSAGE_COLUMNS = 'id, ticket_id, direction, from_email, to_email, to_emails, cc_emails, subject, text_body, is_internal_note, sent_at, created_at'
const MAIL_ATTACHMENT_COLUMNS = 'id, message_id, filename, mime_type, size_bytes, skipped_reason, created_at'

async function mailSection(db, contactId) {
  const tickets = await section(db, {
    table: 'email_tickets', select: MAIL_TICKET_COLUMNS, eq: { contact_id: contactId }, orderCol: 'created_at',
  })

  const stamped = await fetchAllRows(db, {
    table: 'email_inbox_messages', select: MAIL_MESSAGE_COLUMNS, eq: { contact_id: contactId }, orderCol: 'created_at',
  })
  const onTickets = await fetchAllRowsIn(db, {
    table: 'email_inbox_messages', select: MAIL_MESSAGE_COLUMNS,
    inCol: 'ticket_id', values: tickets.rows.map(t => t.id), orderCol: 'created_at',
  })
  const merged = await fetchAllRowsIn(db, {
    table: 'email_inbox_messages', select: MAIL_MESSAGE_COLUMNS,
    inCol: 'merged_from_ticket_id', values: tickets.rows.map(t => t.id), orderCol: 'created_at',
  })
  const messageById = new Map()
  for (const m of [...stamped.rows, ...onTickets.rows, ...merged.rows]) messageById.set(m.id, m)
  const messageRows = [...messageById.values()]
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  const messages = {
    count: messageRows.length,
    truncated: stamped.truncated || onTickets.truncated || merged.truncated,
    rows: messageRows,
  }

  const attachmentsRaw = await fetchAllRowsIn(db, {
    table: 'email_ticket_attachments', select: MAIL_ATTACHMENT_COLUMNS,
    inCol: 'message_id', values: messageRows.map(m => m.id), orderCol: 'created_at',
  })
  const attachments = { count: attachmentsRaw.rows.length, truncated: attachmentsRaw.truncated, rows: attachmentsRaw.rows }

  return {
    tickets,
    messages,
    attachments,
    truncated: tickets.truncated || messages.truncated || attachments.truncated,
  }
}

/**
 * Build the full DSAR bundle for a contact row (caller has already
 * loaded + location-authorised the contact).
 */
export async function buildContactExport(db, contact) {
  const byContact = (table, select, orderCol = 'created_at') =>
    section(db, { table, select, eq: { contact_id: contact.id }, orderCol })

  const [preferences, consentLog, emailSends, bookings, activities, notes] = await Promise.all([
    byContact('contact_preferences', 'email_marketing, email_administrative, whatsapp_marketing, whatsapp_administrative, sms_marketing, sms_administrative, created_at, updated_at'),
    byContact('consent_log', 'channel, action, source, created_at'),
    byContact('email_sends', 'source_type, subject, status, sent_at, created_at'),
    byContact('bookings', 'booking_date, start_time, status, created_at'),
    byContact('activities', 'type, title, notes, created_at'),
    byContact('notes', 'content, created_at'),
  ])

  // DSAR-CONSENT.1 — consent_log.action carried two spellings of the same two
  // facts until mig 516 unified them (opt_out/opted_out, opt_in/opted_in).
  //
  // DECISION: emit the NORMALISED action, and keep the stored string beside it
  // as `action_raw` whenever the two differ.
  //
  // The case for a raw dump is real — this bundle answers a subject access
  // request, it is evidence about what the controller holds, and quietly
  // rewriting a stored value is the kind of thing that makes an export
  // unusable as evidence. But the case against showing `opted_out` next to
  // `opt_out` is stronger: Article 15 entitles the subject to their personal
  // data in an intelligible form, and two spellings of one fact are not
  // intelligible — a subject (or a regulator reading over their shoulder)
  // cannot tell whether two different things happened to them. That is a
  // misleading export, which is a worse failure than a cosmetic one.
  //
  // Emitting both settles it without choosing: the reader gets one vocabulary,
  // and nothing that was stored is hidden. `action_raw` is omitted when it
  // would just duplicate `action`, so for current data (everything post-mig-516,
  // held to the vocabulary by a CHECK constraint) the bundle is byte-identical
  // to before — the divergence only surfaces on a bundle built from an older
  // dump, which is the only case where it matters. An action the vocabulary
  // does not recognise passes through verbatim, per normaliseConsentAction's
  // own rule: rendering an unknown string as if it were an opt-in would be the
  // worst outcome of the three.
  consentLog.rows = consentLog.rows.map((row) => {
    const action = normaliseConsentAction(row.action)
    return action === row.action ? row : { ...row, action, action_raw: row.action }
  })

  // Message history hangs off conversations, not the contact directly.
  const messages = {}
  for (const [convTable, msgTable, key] of [
    ['whatsapp_conversations', 'whatsapp_messages', 'whatsapp'],
    ['instagram_conversations', 'instagram_messages', 'instagram'],
  ]) {
    try {
      const { rows: convs } = await fetchAllRows(db, {
        table: convTable,
        select: 'id, created_at',
        eq: { contact_id: contact.id },
        orderCol: 'created_at',
      })
      const convSections = []
      for (const conv of convs) {
        convSections.push(
          await section(db, {
            table: msgTable,
            select: 'direction, message_type, body, sent_at, created_at',
            eq: { conversation_id: conv.id },
            orderCol: 'created_at',
          })
        )
      }
      messages[key] = {
        conversations: convs.length,
        count: convSections.reduce((n, s) => n + s.count, 0),
        truncated: convSections.some((s) => s.truncated),
        rows: convSections.flatMap((s) => s.rows),
      }
    } catch {
      // A channel table this deployment doesn't have (or a column
      // drift) yields an explicit error marker, never a silent hole.
      messages[key] = { error: 'unavailable' }
    }
  }

  // Same posture as the channel loop above: an explicit error marker, never a
  // silent hole. The mail tables exist in every deployment since mig 482, so
  // this branch is column drift or an outage, and the operator sees which.
  let mail
  try {
    mail = await mailSection(db, contact.id)
  } catch {
    mail = { error: 'unavailable' }
  }

  return {
    format: 'un1t-crm contact export v1',
    generated_at: new Date().toISOString(),
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      created_at: contact.created_at,
      location_id: contact.location_id,
    },
    sections: {
      preferences,
      consent_log: consentLog,
      email_sends: emailSends,
      bookings,
      activities,
      notes,
      messages,
      mail,
    },
  }
}
