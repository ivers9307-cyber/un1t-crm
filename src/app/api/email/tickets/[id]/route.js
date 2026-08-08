import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { emailHtmlDocument } from '@/lib/email-html'
import {
  threadParticipants,
  latestCorrespondence,
  replyMode,
} from '@/lib/email-recipients'
import { attachmentPreviewKind } from '@/lib/email-attachment-preview'
import { loadTicketForUser, loadOwnAddresses } from '../_helpers'

// GET /api/email/tickets/[id] — one ticket and its thread (EMAIL-TICKET.4).
//
// 404 — never 403 — for a ticket that does not exist, sits at a location the
// caller cannot reach, sits at a location where they do not hold `email_inbox`,
// OR sits on a mailbox they cannot see. All four are the same answer from
// outside, so an id can't be probed and the set of addresses a studio runs
// can't be enumerated.
//
// All four live in loadTicketForUser (EMAIL-TICKET-CLEANUP.1). The permission
// one used to sit at the top of this route, where it could only ever resolve at
// the caller's ACTIVE location — a different question from the one a route
// keyed on a ticket id is asked.
//
// Unlike the conversations route this does NOT reset unread_count as a side
// effect of reading: marking read is its own POST (…/read), so opening a
// ticket to look at it is idempotent and a GET stays a GET.

// A ticket thread is short by construction (a long one is a sign it should
// have been split), but fetch newest-first and reverse anyway: ascending +
// limit is what froze the Instagram pane once a thread outgrew the cap.
const MESSAGE_LIMIT = 200

// html_body IS selected now (EMAIL-TICKET.5) but never leaves this route: it
// is replaced by `html_document`, the sanitised, iframe-ready version built by
// src/lib/email-html.js. The raw column stays on disk untouched so the
// sanitiser can be improved later without having destroyed the evidence.
//
// bcc_emails IS SELECTED NOW (EMAIL-CC.1), reversing EMAIL-TICKET.5's blanket
// "never appears in any client-facing payload". THE AUDIENCE IS THE POINT: the
// only client this route has is a staff member who already passed
// loadTicketForUser — location access, the email_inbox key AT THAT LOCATION,
// and a grant on the mailbox this ticket arrived at. That is exactly the
// population mig 482's own COMMENT names ("thereafter read only by staff on
// the ticket"), and a colleague who cannot tell whether accounts@ was copied
// on a refund reply is being asked to work blind. The rule that actually
// matters is unchanged and stricter for being stated separately: bcc_emails
// must never reach a MEMBER-VISIBLE surface and must never be read back as a
// RECIPIENT of a later reply or forward. Neither is this route.
//
// conversation_id is absent (EMAIL-TICKET.6). Nothing downstream read it —
// shapeMessages spread it straight through to the client and no web or mobile
// surface touched it — while email_conversations is being retired, so naming it
// here was a live dependency on a column scheduled to be dropped. The reply
// route's legacy mirror still reads the column, but through its own select.
const MESSAGE_COLUMNS = [
  'id', 'ticket_id', 'contact_id', 'location_id', 'direction',
  'from_email', 'to_email', 'to_emails', 'cc_emails', 'bcc_emails',
  'subject', 'text_body', 'html_body',
  'is_internal_note', 'author_profile_id',
  // EMAIL-FORWARD.1 (mig 501) — set on an outbound message that is a FORWARD,
  // naming the message on this same ticket whose content it passed on. NULL on
  // everything else. The thread renders its marker off this rather than off the
  // "Fwd: " subject prefix, which is editable text.
  'forwarded_message_id',
  'postmark_message_id', 'rfc_message_id', 'source', 'status', 'sent_at', 'created_at',
  // EMAIL-DELIVERY.1 (mig 498) — what Postmark told us happened to an outbound
  // message. All four are NULL until an event arrives, and the thread renders
  // that silence as "no claim", never as success or failure.
  'delivery_status', 'delivery_status_at', 'delivery_detail', 'delivery_bounce_type',
].join(', ')

// A thread's authors are a handful of people, but every .select() caps at
// 1,000 rows whatever the caller asks for, so the bound is stated.
const AUTHOR_LIMIT = 200

// Same reasoning for attachments: 200 messages × a few files each still has to
// sit under the 1,000-row cap, and an unstated bound is a silently truncated
// list rather than an error.
const ATTACHMENT_LIMIT = 500

// A ticket may hold 200 messages and each html_body may be 300k, so an
// unbudgeted response is 60 MB of quoted marketing chain. Sanitised documents
// are produced newest-first (the fetch is already descending) until this much
// output exists; older messages fall back to their text with a note saying so.
// A thread that long is pathological — but "pathological" is exactly when a
// support queue must still open.
const HTML_BUDGET_BYTES = 1_500_000

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket, mailbox } = loaded

  const [
    { data: messagesDesc, error: messagesErr },
    { data: contact, error: contactErr },
  ] = await Promise.all([
    db.from('email_inbox_messages')
      .select(MESSAGE_COLUMNS)
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_LIMIT),
    ticket.contact_id
      ? db.from('contacts')
        .select('id, name, first_name, email, pipeline_stage_slug')
        .eq('id', ticket.contact_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  // FAIL LOUDLY (EMAIL-TICKET.6). Both results used to be destructured without
  // their `.error` and consumed as `x || []` / `x || null`, so any query
  // failure — a dropped column, a revoked grant, a connection blip — was
  // served as HTTP 200 with an empty thread. An operator would read that as
  // "the member never wrote", which is the single worst thing a support queue
  // can say, and nothing was logged for anyone to notice it happening.
  if (messagesErr) {
    console.error('[tickets/:id] messages query failed:', messagesErr.message)
    return NextResponse.json({ success: false, error: messagesErr.message }, { status: 500 })
  }
  if (contactErr) {
    console.error('[tickets/:id] contact lookup failed:', contactErr.message)
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }

  const { messages, attachmentsUnavailable } = await shapeMessages(db, messagesDesc || [])

  // ── Who a reply would reach (EMAIL-CC.1) ──────────────────────────
  // Computed HERE, with the SAME functions the reply route uses, so the button
  // that says "Reply All (4 people)" and the send that actually happens cannot
  // disagree. The composer must never have to re-derive this from the message
  // list: a second implementation is a second chance to include a bcc.
  //
  // NULL is a real answer, not a failure to handle. Without the own-address
  // list the set would wrongly contain our own mailbox, and a label naming an
  // extra recipient who will in fact be excluded is worse than no label — the
  // UI falls back to "reply to the requester" and the reply route recomputes
  // the truth at send time regardless.
  const own = await loadOwnAddresses(db, ticket.location_id)
  let replyRecipients = null
  if (!own.response) {
    const participants = threadParticipants(
      latestCorrespondence(messagesDesc || []),
      { exclude: own.addresses },
    )
    const to = participants.length ? participants : [ticket.requester_email].filter(Boolean)
    replyRecipients = { to, mode: replyMode(to) }
  }

  return NextResponse.json({
    success: true,
    data: {
      // `mailbox` is the account this ticket arrived at, resolved through the
      // caller's visible set — so it is safe to render, and it is what the
      // reply goes back out from.
      ticket: { ...ticket, mailbox, contact: contact || null },
      messages,
      // { to: string[], mode: 'reply' | 'reply_all' }, or null — see above.
      // `to` is derived from From/To/Cc only; bcc_emails is never a
      // participant, so it can never appear here.
      reply_recipients: replyRecipients,
      // True when the attachment query failed. The thread is complete; the
      // FILE list is not, and the UI must say so rather than imply there were
      // none.
      attachments_unavailable: attachmentsUnavailable,
    },
  })
}

/**
 * The files that came with a thread, grouped by message.
 *
 * Returns `{ byMessage, unavailable }`. `unavailable` is deliberate: an
 * attachment lookup that fails must not render as "this email had no
 * attachments". That is the same silent-wrong-answer shape EMAIL-TICKET.6
 * fixed for the thread itself — an operator reading "no attachments" when the
 * member did send one will tell them so. It is NOT a 500, though: the
 * correspondence is complete and readable either way, and refusing to open a
 * support ticket over an attachment query is the disproportionate answer.
 *
 * storage_path never leaves this function. The client gets `stored` and, when
 * it wants the bytes, hits …/attachments/[attachmentId] for a signed URL.
 */
async function loadAttachments(db, messageIds) {
  if (messageIds.length === 0) return { byMessage: new Map(), unavailable: false }

  const { data, error } = await db.from('email_ticket_attachments')
    .select('id, message_id, filename, mime_type, size_bytes, storage_path, skipped_reason, attachment_index')
    .in('message_id', messageIds)
    .order('attachment_index', { ascending: true })
    .limit(ATTACHMENT_LIMIT)
  if (error) {
    console.error('[tickets/:id] attachment lookup failed:', error.message)
    return { byMessage: new Map(), unavailable: true }
  }

  const byMessage = new Map()
  for (const row of data || []) {
    const list = byMessage.get(row.message_id) || []
    list.push({
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      stored: !!row.storage_path,
      skipped_reason: row.skipped_reason,
      // EMAIL-ATTACH-PREVIEW.1 — 'image' | 'pdf' | null. THE SERVER DECIDES
      // WHAT MAY BE PREVIEWED, and says so here, so the thread can draw a
      // chip that already knows whether clicking it opens a picture or a
      // download prompt — without a speculative request per file.
      //
      // It is not merely a hint the browser could have computed: the allow-list
      // is a security decision (image/svg+xml is scriptable markup from an
      // unauthenticated stranger), and a copy of it living in the client is a
      // copy that can drift from the one the …/preview route enforces. One
      // home, and the browser is not it. A never-stored row is never
      // previewable whatever its type — there are no bytes.
      preview_kind: row.storage_path ? attachmentPreviewKind(row.mime_type) : null,
    })
    byMessage.set(row.message_id, list)
  }
  return { byMessage, unavailable: false }
}

/**
 * Turn stored rows into what the thread may render: authors resolved, HTML
 * sanitised, raw html_body dropped, attachments attached.
 *
 * @param {object} db  service-role client
 * @param {object[]} rows  messages, NEWEST FIRST — the HTML budget spends
 *   itself on the most recent correspondence, which is the part anyone reads.
 * @returns {Promise<{messages: object[], attachmentsUnavailable: boolean}>}
 *   messages oldest first
 */
async function shapeMessages(db, rows) {
  const { byMessage: attachmentsByMessage, unavailable: attachmentsUnavailable } =
    await loadAttachments(db, rows.map(m => m.id).filter(Boolean))

  // WHO WROTE IT. Resolving names needs a read of `profiles`, which the
  // `authenticated` role has no grant on — a client-side embed would 500 the
  // whole select (CLAUDE.md). This is a service-role route, so the lookup
  // belongs exactly here and nowhere nearer the browser.
  const authorIds = [...new Set(rows.map(m => m.author_profile_id).filter(Boolean))]
  let authorNames = new Map()
  if (authorIds.length > 0) {
    const { data: profiles, error: authorErr } = await db.from('profiles')
      .select('id, full_name')
      .in('id', authorIds)
      .limit(AUTHOR_LIMIT)
    // Deliberately NOT a 500, unlike the two queries above (EMAIL-TICKET.6):
    // the thread itself is complete either way, and an unresolved name degrades
    // to `author_name: null` — already the normal render for every message
    // written before mig 493 added the column. Refusing to open a support
    // ticket because a display-name lookup blipped would be the disproportionate
    // answer. It is logged rather than swallowed so it is still discoverable.
    if (authorErr) console.error('[tickets/:id] author name lookup failed:', authorErr.message)
    authorNames = new Map((profiles || []).map(p => [p.id, p.full_name]))
  }

  let budget = HTML_BUDGET_BYTES

  const shaped = rows.map(row => {
    // html_body is destructured out and never spread into the response. It is
    // hostile input from an unauthenticated stranger; the browser gets the
    // sanitised document or it gets the text.
    const { html_body: raw, ...rest } = row
    const base = {
      ...rest,
      author_name: authorNames.get(row.author_profile_id) || null,
      attachments: attachmentsByMessage.get(row.id) || [],
      html_document: null,
      html_blocked_images: 0,
      html_unsafe: false,
      html_omitted: false,
    }

    // An internal note is plain text by construction (mig 493: the signature
    // is plain text precisely so no un-sanitised HTML path exists on the
    // staff side). It never goes near the HTML path.
    if (row.is_internal_note || !raw) return base

    if (budget <= 0) return { ...base, html_omitted: true }

    // emailHtmlDocument() swallows its own throw and reports `failed`; there
    // is no branch anywhere that returns `raw`.
    const { document, blockedImages, failed } = emailHtmlDocument(raw)
    budget -= document ? document.length : 0
    return {
      ...base,
      html_document: document,
      html_blocked_images: blockedImages,
      html_unsafe: failed,
    }
  })

  return { messages: shaped.reverse(), attachmentsUnavailable }
}
