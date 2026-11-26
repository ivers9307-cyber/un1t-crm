// POST /api/sequences/[id]/test-email
//
// FLOWTEST.1 — sends ONE copy of an automation's email step to the signed-in
// staff member, from the step content currently in the editor (saved or not),
// so it can be checked in a real inbox before the flow is published. Same idea
// as /api/campaigns/[id]/send-test.
//
// Differences vs a real step send (src/lib/sequences/steps.js):
//   - one recipient: the staff member's own address, never a contact
//   - subject prefixed "[TEST] "
//   - merge tags render against the staff member's contact at this studio if
//     there is one, else sample values; run-only tags (payment, trial link,
//     booking prefill) are blank, because there is no run
//   - no enrolment, email_sends or activity rows: it is not a send to anyone
//   - broadcast stream with a dummy unsubscribe link, so the footer and
//     headers look as they will
//
// Gate: `email` at the sequence's studio. A sequence at a studio the user
// cannot see answers 404, like every other sequence route.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { sequenceNotFound } from '@/lib/sequence-access'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { sendEmail, applyMergeTags, appendUnsubscribeFooter } from '@/lib/postmark'
import { resolveEmailSender } from '@/lib/tenant-email'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { getLocationBranding } from '@/lib/location-branding'
import { zoneOfLocation } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  subject: z.string().max(500).nullable().optional(),
  html_content: z.string().max(500_000).nullable().optional(),
  template_id: uuidLike.nullable().optional(),
})

export const POST = withAuth({ permission: 'email', location: false }, async ({ user, db, request, params }) => {
  if (!uuidLike.safeParse(params?.id).success) return sequenceNotFound()

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: sequence, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id, name')
    .eq('id', params.id)
    .maybeSingle()
  if (seqErr) return NextResponse.json({ success: false, error: 'Could not load the automation' }, { status: 500 })
  if (!sequence) return sequenceNotFound()
  const guard = assertLocationAccessOr404(user, sequence.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, sequence.location_id, 'email')) return sequenceNotFound()

  const { data: location } = await db
    .from('locations')
    .select('name, timezone')
    .eq('id', sequence.location_id)
    .maybeSingle()

  const recipient = String(user.email || '').trim().toLowerCase()
  if (!recipient.includes('@')) {
    return NextResponse.json({ success: false, error: 'Your profile has no email address to send the test to.' }, { status: 400 })
  }

  // Same resolution order as the real send: inline HTML first, else the template.
  let subject = body.subject || ''
  let html = body.html_content || ''
  if (!html && body.template_id) {
    const { data: tpl } = await db
      .from('email_templates')
      .select('subject, html_content')
      .eq('id', body.template_id)
      .eq('location_id', sequence.location_id)
      .maybeSingle()
    if (tpl) {
      subject = subject || tpl.subject || ''
      html = tpl.html_content || ''
    }
  }
  if (!html || !subject) {
    return NextResponse.json({ success: false, error: 'The step needs a subject and some content before it can be tested.' }, { status: 400 })
  }

  const { data: own } = await db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug')
    .eq('email', recipient)
    .eq('location_id', sequence.location_id)
    .maybeSingle()
  const firstName = String(user.full_name || 'Test').split(/\s+/)[0]
  const contact = own || {
    id: 'test', name: user.full_name || 'Test Recipient', first_name: firstName,
    last_name: '', email: recipient, phone: null, pipeline_stage_slug: 'new_lead',
  }

  let baseUrl = ''
  try { baseUrl = await resolveCustomerBaseUrl(db, sequence.location_id) } catch { baseUrl = '' }
  const unsubscribeUrl = `${baseUrl}/unsubscribe/test-token`
  const { companyName } = await getLocationBranding(db, sequence.location_id)
  const extras = {
    location_name: location?.name || '',
    company_name: companyName || '',
    zone: zoneOfLocation(location),
    unsubscribe_url: unsubscribeUrl,
    preference_url: `${baseUrl}/preferences/test-token`,
  }
  const mergedSubject = '[TEST] ' + applyMergeTags(subject, contact, extras)
  const mergedHtml = appendUnsubscribeFooter(applyMergeTags(html, contact, extras), unsubscribeUrl)

  const sender = await resolveEmailSender(db, sequence.location_id)
  try {
    await sendEmail({
      to: recipient,
      subject: mergedSubject,
      htmlBody: mergedHtml,
      sender,
      stream: 'broadcast',
      tag: `sequence-test-${sequence.id}`,
      metadata: { sequence_id: sequence.id, test_send: '1', sent_by: user.id || '' },
      unsubscribeUrl,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Test send failed: ${e?.message || e}` }, { status: 502 })
  }
  return NextResponse.json({
    success: true,
    data: { to: recipient, using_real_contact: !!own },
  })
})
