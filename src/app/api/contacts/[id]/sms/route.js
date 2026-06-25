// POST /api/contacts/[id]/sms — ad-hoc one-off SMS to a single contact.
//
// First SMS surface in the per-location-Twilio model (mig 059). Future
// surfaces (broadcasts, sequence step type 'sms', automation actions)
// will reuse the same `sendLocationSms` + sms_status guard pattern
// established here.
//
// Authorization:
//   - Must be authenticated.
//   - Must have the 'sms' permission at the active location
//     (per-location override OR role default — mig 058 model).
//   - Contact's location_id must be one of the caller's locations
//     (assertLocationAccess — same IDOR protection email/whatsapp use).
//
// Send-side guards:
//   - contact.sms_status === 'active' (rejects 'opted_out' / 'invalid').
//   - contact.phone is present.
//
// Side effects on success:
//   - Sends via Twilio (sendLocationSms) using the contact's location's
//     twilio_alpha_sender_id (or env fallback).
//   - Inserts an `activities` row of type 'sms_sent' with the rendered
//     body (post merge-tag substitution) so the contact timeline shows
//     it. Mirrors the whatsapp_sent / email pattern.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { sendLocationSms, TwilioError } from '@/lib/twilio'
import { applyMergeTags } from '@/lib/postmark'

export const runtime = 'nodejs'

// 1600 chars covers ~10 SMS segments — enough for a long message
// but small enough that we'll never accidentally send a multi-K body.
// Per-segment count is enforced client-side via the char counter.
const SmsBodySchema = z.object({
  body: z.string().min(1).max(1600),
})

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  // Web `sms` permission OR the mobile `sms` permission (MOBILE-CONTACT-
  // SEND.1) — the mobile contact card sends through this same route so the
  // text comes from the company Twilio sender, not the staffer's phone.
  if (!hasPermission(user, 'sms') && !hasMobilePermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled at this location for your role' }, { status: 403 })
  }

  const validation = await validateBody(request, SmsBodySchema)
  if (!validation.ok) return validation.response
  const { body } = validation.data

  const { id: contactId } = params
  const db = createServerClient()

  // Pull the contact + its location's sender ID in one round-trip.
  // The locations join gives us twilio_alpha_sender_id without a
  // second query.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug, sms_status, location_id, locations:location_id(id, name, twilio_alpha_sender_id)')
    .eq('id', contactId)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // IDOR guard — caller must be assigned to the contact's location.
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  if (!contact.phone) {
    return NextResponse.json({ success: false, error: 'Contact has no phone number on file' }, { status: 400 })
  }
  if (contact.sms_status !== 'active') {
    return NextResponse.json({
      success: false,
      error: `Cannot send — contact's SMS status is '${contact.sms_status}'. They've opted out or the number is marked invalid.`,
    }, { status: 400 })
  }

  // Apply merge tags so authors can use {{first_name}} etc. Same
  // tag set as email/whatsapp surfaces.
  const renderedBody = applyMergeTags(body, contact, {
    location_name: contact.locations?.name || '',
  })

  let twilioResult
  try {
    twilioResult = await sendLocationSms({
      location: contact.locations,
      to: contact.phone,
      body: renderedBody,
    })
  } catch (e) {
    if (e instanceof TwilioError) {
      return NextResponse.json(
        { success: false, error: `Twilio error: ${e.message}`, code: e.code },
        { status: 502 }
      )
    }
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to send SMS' },
      { status: 500 }
    )
  }

  // Activity log. type='sms_sent' mirrors the whatsapp_sent pattern;
  // future inbound (Phase 2 broadcasts won't be inbound) would be
  // 'sms_received'. The activityIcons map on the contact page
  // gracefully handles unknown types so this won't error.
  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: contact.location_id,
    type: 'sms_sent',
    subject: `SMS sent`,
    note: renderedBody,
    created_by: user.id,
  })

  return NextResponse.json({
    success: true,
    data: {
      sid: twilioResult.sid,
      status: twilioResult.status,
      from: twilioResult.from,
      to: twilioResult.to,
      body_preview: renderedBody.length > 80 ? renderedBody.slice(0, 80) + '…' : renderedBody,
    },
  })
}
