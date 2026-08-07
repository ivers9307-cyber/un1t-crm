import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { emailHtmlDocument } from '@/lib/email-html'
import { loadTicketForUser } from '../_helpers'

// GET /api/email/tickets/[id] — one ticket and its thread (EMAIL-TICKET.4).
//
// 404 — never 403 — for a ticket that does not exist, sits at a location the
// caller cannot reach, OR sits on a mailbox they cannot see. All three are
// the same answer from outside, so an id can't be probed and the set of
// addresses a studio runs can't be enumerated.
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
// bcc_emails remains absent: it is stored for audit only and the spec pins
// "bcc_emails never appears in any client-facing payload".
//
// conversation_id is absent too (EMAIL-TICKET.6). Nothing downstream read it —
// shapeMessages spread it straight through to the client and no web or mobile
// surface touched it — while email_conversations is being retired, so naming it
// here was a live dependency on a column scheduled to be dropped. The reply
// route's legacy mirror still reads the column, but through its own select.
const MESSAGE_COLUMNS = [
  'id', 'ticket_id', 'contact_id', 'location_id', 'direction',
  'from_email', 'to_email', 'cc_emails', 'subject', 'text_body', 'html_body',
  'is_internal_note', 'author_profile_id',
  'postmark_message_id', 'rfc_message_id', 'source', 'status', 'sent_at', 'created_at',
].join(', ')

// A thread's authors are a handful of people, but every .select() caps at
// 1,000 rows whatever the caller asks for, so the bound is stated.
const AUTHOR_LIMIT = 200

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

  if (!hasPermission(user, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

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

  const messages = await shapeMessages(db, messagesDesc || [])

  return NextResponse.json({
    success: true,
    data: {
      // `mailbox` is the account this ticket arrived at, resolved through the
      // caller's visible set — so it is safe to render, and it is what the
      // reply goes back out from.
      ticket: { ...ticket, mailbox, contact: contact || null },
      messages,
    },
  })
}

/**
 * Turn stored rows into what the thread may render: authors resolved, HTML
 * sanitised, raw html_body dropped.
 *
 * @param {object} db  service-role client
 * @param {object[]} rows  messages, NEWEST FIRST — the HTML budget spends
 *   itself on the most recent correspondence, which is the part anyone reads.
 * @returns {Promise<object[]>} the same messages, oldest first
 */
async function shapeMessages(db, rows) {
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

  return shaped.reverse()
}
