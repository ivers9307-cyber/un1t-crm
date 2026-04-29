import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// One-click unsubscribe (used by List-Unsubscribe header)
// POST /api/unsubscribe/[token]
export async function POST(request, { params }) {
  const db = createServerClient()
  const { token } = params

  // Find the contact preference by token
  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email, location_id)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 404 })
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

// GET redirects to preference centre
export async function GET(request, { params }) {
  const { token } = params
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://crm.un1t.ie'
  return NextResponse.redirect(`${baseUrl}/preferences/${token}`)
}
