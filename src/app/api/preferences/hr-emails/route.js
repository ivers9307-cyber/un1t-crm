// GET /api/preferences/hr-emails?cid=<contact_id>&scope=hr
//
// Public single-click unsubscribe link for the post-class HR email.
// Member clicks "Stop these emails" in their inbox; we flip
// contacts.hr_post_class_emails_enabled to false and render a
// confirmation page.
//
// Uses the contact_id directly (no token) which is acceptable for
// this scope: the only thing the endpoint can do is FLIP A FLAG to
// "less mail" for the named contact. Worst-case adversarial use is
// "someone unsubscribes a stranger's HR emails", which is a
// recoverable annoyance, not a data breach. Same trade-off the
// existing /api/preferences and /api/unsubscribe routes make.
//
// Public path — already in middleware.publicPaths via /api/preferences/.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const url = new URL(request.url)
  const contactId = (url.searchParams.get('cid') || '').trim()
  const scope = (url.searchParams.get('scope') || 'hr').trim()

  if (!contactId) {
    return htmlResponse(`<h1>Invalid link</h1><p>This unsubscribe link is missing a contact id.</p>`, 400)
  }
  if (scope !== 'hr') {
    return htmlResponse(`<h1>Unknown scope</h1>`, 400)
  }

  const db = createServerClient()
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, email, hr_post_class_emails_enabled')
    .eq('id', contactId)
    .single()
  if (error || !contact) {
    return htmlResponse(`<h1>Contact not found</h1><p>This link may have expired.</p>`, 404)
  }

  if (contact.hr_post_class_emails_enabled !== false) {
    const { error: updErr } = await db
      .from('contacts')
      .update({ hr_post_class_emails_enabled: false })
      .eq('id', contactId)
    if (updErr) {
      logWarn('hr-pref', 'failed to update flag', { contactId, err: updErr })
      return htmlResponse(`<h1>Couldn't update preferences</h1><p>Please try again later or email us.</p>`, 500)
    }
    logInfo('hr-pref', 'unsubscribed from hr emails', { contactId })
  }

  return htmlResponse(`
    <h1>You're unsubscribed</h1>
    <p>You won't get post-class heart-rate summary emails any more.</p>
    <p style="margin-top:24px;font-size:13px;color:#666;">
      Changed your mind? You can re-enable these in your app account
      → Settings, or just reply to any email and we'll flip it back.
    </p>
  `)
}

function htmlResponse(bodyHtml, status = 200) {
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Email preferences · UN1T</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin:0; padding:48px 24px; font-family: ui-sans-serif, system-ui, sans-serif;
           background:#f4f4f5; color:#111; }
    .card { max-width:480px; margin:0 auto; background:#fff; padding:32px;
            border-radius:12px; border:1px solid #e5e7eb; }
    h1 { margin:0 0 12px 0; font-size:22px; }
    p  { margin:8px 0; line-height:1.5; color:#444; }
  </style>
</head><body>
  <div class="card">${bodyHtml}</div>
</body></html>`
  return new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
