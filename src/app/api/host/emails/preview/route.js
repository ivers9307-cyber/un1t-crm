// POST /api/host/emails/preview — HOST-EMAILS.2. What a recipient would get:
// the same renderHostCampaignHtml the queue and the test send use (sanitizer,
// shell, footer), sample merge values, the inert unsubscribe token. Reads the
// host's sender name; stores nothing.
//
// The composer's own live preview renders the raw body — this route exists
// because that is not faithful: renderHostCampaignHtml sanitizes (keeps
// <style> with its CSS scrubbed, keeps one canonical viewport <meta>, strips
// scripts/iframes/forms/other <meta>/on* handlers) and injects the mandatory
// unsubscribe footer, so a host could otherwise approve a layout no
// recipient will ever see (the same gap send-test closed for the actual
// send).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { renderHostCampaignHtml } from '@/lib/host-campaign-email'
import { applyMergeTags } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  subject: z.string().max(200).optional().default(''),
  body_html: z.string().min(1).max(300000),
})

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Add some content first.' }, { status: 400 })

  const db = createServerClient()
  const { data: host, error: hostErr } = await db
    .from('event_hosts')
    .select('id, name, sender_name, sender_email')
    .eq('id', session.host.id)
    .maybeSingle()
  if (hostErr) return NextResponse.json({ success: false, error: hostErr.message }, { status: 500 })
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // An inert token, same reasoning as send-test: the footer must RENDER, but
  // a real signed token in a preview surface would let it unsubscribe a
  // genuine contact if it ever leaked out.
  let baseUrl
  try { baseUrl = getAppUrl() } catch { baseUrl = '' }
  const unsubscribeUrl = `${baseUrl}/unsubscribe/host/test-token`

  const sampleContact = {
    first_name: 'Sample',
    last_name: 'Recipient',
    name: 'Sample Recipient',
    email: session.email || 'sample@example.com',
  }

  const html = applyMergeTags(
    renderHostCampaignHtml({
      host,
      subject: parsed.data.subject,
      bodyHtml: parsed.data.body_html,
      unsubscribeUrl,
    }),
    sampleContact,
    { unsubscribe_url: unsubscribeUrl },
  )

  return NextResponse.json({ success: true, data: { html } })
}
