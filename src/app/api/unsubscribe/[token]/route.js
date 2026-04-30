import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { getRequestOrigin } from '@/lib/app-url'

export const runtime = 'nodejs'

// 10 attempts per IP per 15 minutes. The token is a UUID (122 bits of
// entropy), so brute force is hopeless even without a limiter — this mainly
// slows down a misconfigured email client looping on the unsubscribe URL.
const RL = { max: 10, windowMs: 15 * 60_000 }

// One-click unsubscribe (used by List-Unsubscribe header)
// POST /api/unsubscribe/[token]
export async function POST(request, { params }) {
  const db = createServerClient()
  const { token } = params

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `unsubscribe:${ip}`, RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  // Find the contact preference by token
  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email, location_id)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  // Unsubscribe from email marketing
  await db
    .from('contact_preferences')
    .update({ email_marketing: false, updated_at: new Date().toISOString() })
    .eq('id', pref.id)

  // Log to consent audit trail
  await db.from('consent_log').insert({
    contact_id: pref.contact_id,
    channel: 'email_marketing',
    action: 'opt_out',
    source: 'one_click_unsubscribe',
    ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
  })

  // Update contact email_status
  await db
    .from('contacts')
    .update({ email_status: 'unsubscribed' })
    .eq('id', pref.contact_id)

  return NextResponse.json({ success: true, message: 'Unsubscribed successfully' })
}

// GET redirects to preference centre. Use the request's own origin so the
// redirect always lands on the same domain the user typed — no env var
// dependency, no chance of redirecting to a stale domain.
export async function GET(request, { params }) {
  const { token } = params
  return NextResponse.redirect(`${getRequestOrigin(request)}/preferences/${token}`)
}
