import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendEmail } from '@/lib/postmark'
import { replySubject, buildReplyHeaders, inboundPreview } from '@/lib/email-inbox'

const SendSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  subject: z.string().trim().max(500).optional(),
})

// Minimal text → HTML for the reply body. Replies are 1:1 plain
// conversation, not designed marketing mail — escaped text with <br>
// line breaks is exactly what a human reply looks like.
function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">${escaped}</div>`
}

// POST /api/email/conversations/[id]/send — operator reply from the
// unified inbox (EMAIL-INBOX.1).
//
// Replies ride Postmark's TRANSACTIONAL stream ('outbound'), not
// broadcast: a 1:1 human answer to an inbound enquiry is transactional
// mail (no List-Unsubscribe chrome, no marketing-consent gate — the
// customer wrote to us first). Threading headers (In-Reply-To /
// References from the last inbound message's stored RFC ids) keep the
// reply in the customer's mail-client thread; Reply-To points back at
// the location's inbound address so the NEXT reply lands here too.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SendSchema)
  if (!validation.ok) return validation.response
  const { text, subject: subjectOverride } = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('email_conversations')
    .select('*, contacts!contact_id(id, name, first_name)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  if (!conversation.counterpart_email) {
    return NextResponse.json({ success: false, error: 'No recipient address for this conversation' }, { status: 400 })
  }

  // Threading anchors + Reply-To, fetched in parallel.
  const [{ data: lastInbound }, { data: location }] = await Promise.all([
    db.from('email_inbox_messages')
      .select('rfc_message_id, references_header, subject')
      .eq('conversation_id', params.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('locations')
      .select('email_inbox_reply_to')
      .eq('id', conversation.location_id)
      .maybeSingle(),
  ])

  const subject = subjectOverride || replySubject(lastInbound?.subject || conversation.subject)
  const headers = buildReplyHeaders({
    rfcMessageId: lastInbound?.rfc_message_id || null,
    referencesHeader: lastInbound?.references_header || null,
  })

  let result
  try {
    result = await sendEmail({
      to: conversation.counterpart_email,
      subject,
      htmlBody: textToHtml(text),
      textBody: text,
      // Without a configured inbound address the reply still sends —
      // the customer's next reply just goes to the From mailbox.
      replyTo: location?.email_inbox_reply_to || undefined,
      stream: 'outbound',
      tag: 'inbox-reply',
      metadata: { conversation_id: params.id, contact_id: conversation.contact_id || '' },
      headers,
    })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }

  const now = new Date().toISOString()
  await db.from('email_inbox_messages').insert({
    conversation_id: params.id,
    contact_id: conversation.contact_id || null,
    location_id: conversation.location_id,
    direction: 'outbound',
    from_email: process.env.POSTMARK_FROM_EMAIL || null,
    to_email: conversation.counterpart_email,
    subject,
    text_body: text,
    postmark_message_id: result.messageId,
    in_reply_to: lastInbound?.rfc_message_id || null,
    source: 'operator',
    status: 'sent',
    sent_at: now,
  })

  // Log to email_sends so the reply shows in the contact's email
  // history and delivery webhooks can track it. contact_id is NOT NULL
  // there, so unlinked conversations skip this log (the inbox message
  // row above is still the operator-facing record).
  if (conversation.contact_id) {
    await db.from('email_sends').insert({
      contact_id: conversation.contact_id,
      location_id: conversation.location_id,
      source_type: 'inbox_reply',
      subject,
      from_email: process.env.POSTMARK_FROM_EMAIL,
      to_email: conversation.counterpart_email,
      postmark_message_id: result.messageId,
      postmark_stream: 'outbound',
      status: 'sent',
    })
  }

  await db.from('email_conversations').update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: inboundPreview(text),
    updated_at: now,
  }).eq('id', params.id)

  return NextResponse.json({ success: true, messageId: result.messageId })
}
