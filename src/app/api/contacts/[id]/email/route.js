// POST /api/contacts/[id]/email — ad-hoc one-off email to a single contact.
//
// MOBILE-CONTACT-SEND.1 — the company-sender counterpart of the SMS
// route. Sends a transactional email from the company Postmark sender
// (outbound stream) so a one-to-one message from the mobile (or web)
// contact card comes from the business, not the staffer's personal mail
// app. Broadcasts / sequences / the campaign editor stay web-only.
//
// Authorization:
//   - Must be authenticated.
//   - Web `email` permission OR mobile `email` permission (the mobile
//     contact card routes its Email button through here).
//   - Contact's location_id must be one of the caller's locations
//     (assertLocationAccess — same IDOR protection sms/whatsapp use).
//
// Send-side guards:
//   - contact.email is present.
//   - contact.email_status is not bounced / complained / unsubscribed.
//
// Side effects on success:
//   - Sends via Postmark sendTransactionalEmail (outbound stream); that
//     helper also logs an `email_sends` row.
//   - Inserts an `activities` row of type 'email_sent' so the contact
//     timeline shows it. Mirrors the sms_sent / whatsapp_sent pattern.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { applyMergeTags, sendTransactionalEmail } from '@/lib/postmark'

export const runtime = 'nodejs'

const EmailBodySchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
})

// Hard email statuses that block any send (same family the broadcast
// + reminder gates use).
const BLOCKED_EMAIL_STATUSES = ['bounced', 'complained', 'unsubscribed']

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Plain-text body → minimal HTML: escape, then newlines to <br>. Keeps
// the email a clean transactional message with no template chrome —
// exactly what an operator typing a quick note expects.
function textToHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'email') && !hasMobilePermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email not enabled at this location for your role' }, { status: 403 })
  }

  const validation = await validateBody(request, EmailBodySchema)
  if (!validation.ok) return validation.response
  const { subject, body } = validation.data

  const { id: contactId } = params
  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug, email_status, location_id, locations:location_id(id, name)')
    .eq('id', contactId)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // IDOR guard — caller must be assigned to the contact's location.
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard

  if (!contact.email) {
    return NextResponse.json({ success: false, error: 'Contact has no email address on file' }, { status: 400 })
  }
  if (contact.email_status && BLOCKED_EMAIL_STATUSES.includes(contact.email_status)) {
    return NextResponse.json({
      success: false,
      error: `Cannot send — contact's email status is '${contact.email_status}'. They've bounced, complained, or unsubscribed.`,
    }, { status: 400 })
  }

  // Merge tags ({{first_name}} etc.) on both subject and body — same tag
  // set as the SMS/email surfaces.
  const mergeCtx = { location_name: contact.locations?.name || '' }
  const renderedSubject = applyMergeTags(subject, contact, mergeCtx)
  const renderedBody = applyMergeTags(body, contact, mergeCtx)

  try {
    await sendTransactionalEmail({
      to: contact.email,
      subject: renderedSubject,
      htmlBody: textToHtml(renderedBody),
      contactId: contact.id,
      locationId: contact.location_id,
      tag: 'contact_adhoc',
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to send email' },
      { status: 502 }
    )
  }

  // Activity log. type='email_sent' mirrors the sms_sent / whatsapp_sent
  // pattern; the activityIcons map gracefully handles unknown types.
  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: contact.location_id,
    type: 'email_sent',
    subject: `Email sent: ${renderedSubject}`.slice(0, 200),
    note: renderedBody,
    created_by: user.id,
  })

  return NextResponse.json({
    success: true,
    data: {
      to: contact.email,
      subject: renderedSubject,
      body_preview: renderedBody.length > 80 ? renderedBody.slice(0, 80) + '…' : renderedBody,
    },
  })
}
