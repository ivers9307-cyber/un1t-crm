// POST /api/host/emails/[id]/send-test — send ONE rendered copy of a draft
// host campaign to a chosen address so the host can check it in a real inbox
// before it goes to the list (HOST-EMAIL.10).
//
// CRM campaigns have had this since CAMPAIGN.1; host campaigns never did, so
// the only review surface was the composer preview. That preview is not
// faithful: it renders the raw body, while the real send puts it through
// renderHostCampaignHtml, which SANITIZES (stripping <style>/<meta>/<script>,
// so every media query in a pasted Canva or Unlayer export disappears) and
// injects the mandatory unsubscribe footer. A host could therefore approve a
// layout in the composer that no recipient will ever see.
//
// Differences vs the real send, and only these:
//   - one recipient, no audience resolution and no consent query (the address
//     is the host's own choice, not a contact)
//   - subject prefixed "[TEST] "
//   - merge tags render against sample values, since there is no contact
//   - the unsubscribe link is an inert placeholder token — the footer's
//     PRESENCE and position are what a test is checking; a live token would
//     let a mis-forwarded test unsubscribe a real contact
//   - writes NOTHING: no host_campaign_sends rows, no status change, no
//     daily-cap consumption. A test must never move the campaign's state.
//
// Everything else is deliberately identical to host-campaign-queue.js so the
// test reproduces the delivered email: same renderer, same From/Reply-To, and
// the same stream split (utility rides 'outbound', marketing 'broadcast').

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { renderHostCampaignHtml } from '@/lib/host-campaign-email'
import { sendEmail, applyMergeTags } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  // Omitted → the session's own email. Under an admin "view as host" session
  // that is the ADMIN's email, not the host's (host-auth returns the staff
  // user's address for an impersonated session), which is what you want: the
  // operator testing the draft gets the copy, not the host.
  to: z.string().email().optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const db = createServerClient()

  // Own campaign or 404 — the .eq('host_id') is the tenancy boundary, and 404
  // (not 403) keeps campaign ids un-enumerable, like every other host route.
  const { data: campaign } = await db
    .from('host_campaigns')
    .select('id, status, subject, body_html, email_type')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Sender identity — HOST_PORTAL_COLS excludes the sender columns, so load
  // them here, exactly as the real send route does.
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, email, sender_domain_verified, sender_email, sender_name, reply_to_email')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // The kill switch applies to a test too: this is a real email leaving the
  // host's domain, so letting a test bypass the gate would be a hole in it.
  if (!host.sender_domain_verified || !host.sender_email) {
    return NextResponse.json(
      { success: false, error: 'Sending is not enabled — ask UN1T to verify your sending domain.' },
      { status: 409 },
    )
  }

  if (!campaign.subject || !campaign.body_html) {
    return NextResponse.json(
      { success: false, error: 'Add a subject and some content before sending a test.' },
      { status: 400 },
    )
  }

  const recipient = (validation.data.to || session.email || '').trim().toLowerCase()
  if (!recipient.includes('@')) {
    return NextResponse.json(
      { success: false, error: 'No recipient email — pass `to`, or set an email on your host account.' },
      { status: 400 },
    )
  }

  // An inert token: the footer must RENDER (that is most of what a test is
  // for), but a real signed token in an email the host may forward around
  // would let a stranger unsubscribe a genuine contact.
  let baseUrl
  try { baseUrl = getAppUrl() } catch { baseUrl = '' }
  const unsubscribeUrl = `${baseUrl}/unsubscribe/host/test-token`

  // Sample personalisation — there is no contact behind a test address, and
  // shipping a literal {{first_name}} would misrepresent the real send.
  const sampleContact = {
    first_name: 'Sample',
    last_name: 'Recipient',
    name: 'Sample Recipient',
    email: recipient,
  }

  const htmlBody = applyMergeTags(
    renderHostCampaignHtml({
      host,
      subject: campaign.subject,
      bodyHtml: campaign.body_html,
      unsubscribeUrl,
    }),
    sampleContact,
    { unsubscribe_url: unsubscribeUrl },
  )
  const subject = '[TEST] ' + (applyMergeTags(campaign.subject, sampleContact) || campaign.subject)

  const senderName = host.sender_name || host.name || ''
  const from = `"${senderName.replace(/"/g, "'")}" <${host.sender_email}>`

  try {
    const result = await sendEmail({
      to: recipient,
      from,
      replyTo: host.reply_to_email || host.email || undefined,
      subject,
      htmlBody,
      stream: campaign.email_type === 'utility' ? 'outbound' : 'broadcast',
      tag: 'host-campaign-test',
      metadata: { host_campaign_id: campaign.id, host_id: host.id, test_send: '1' },
      unsubscribeUrl,
    })
    return NextResponse.json({
      success: true,
      data: { to: recipient, message_id: result?.messageId || null },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Test send failed: ${e?.message || e}` },
      { status: 502 },
    )
  }
}
