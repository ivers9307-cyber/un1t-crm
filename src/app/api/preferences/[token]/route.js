import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/preferences/[token] — fetch current preferences
export async function GET(request, { params }) {
  const db = createServerClient()
  const { token } = params

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    contact: {
      name: pref.contacts?.name,
      email: pref.contacts?.email,
    },
    preferences: {
      email_marketing: pref.email_marketing,
      email_administrative: pref.email_administrative,
      whatsapp_marketing: pref.whatsapp_marketing,
      whatsapp_administrative: pref.whatsapp_administrative,
    },
  })
}

// PUT /api/preferences/[token] — update preferences
export async function PUT(request, { params }) {
  const db = createServerClient()
  const { token } = params
  const body = await request.json()

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 404 })
  }

  const allowed = ['email_marketing', 'email_administrative', 'whatsapp_marketing', 'whatsapp_administrative']
  const updates = {}
  const logEntries = []
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null

  for (const channel of allowed) {
    if (typeof body[channel] === 'boolean' && body[channel] !== pref[channel]) {
      updates[channel] = body[channel]
      logEntries.push({
        contact_id: pref.contact_id,
        channel,
        action: body[channel] ? 'opt_in' : 'opt_out',
        source: 'preference_centre',
        ip_address: ip,
      })
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, message: 'No changes' })
  }

  updates.updated_at = new Date().toISOString()

  await db
    .from('contact_preferences')
    .update(updates)
    .eq('id', pref.id)

  // Log all changes to consent audit trail
  if (logEntries.length > 0) {
    await db.from('consent_log').insert(logEntries)
  }

  // Update contact email_status if email_marketing was changed
  if (typeof updates.email_marketing === 'boolean') {
    await db
      .from('contacts')
      .update({ email_status: updates.email_marketing ? 'active' : 'unsubscribed' })
      .eq('id', pref.contact_id)
  }

  return NextResponse.json({ success: true, message: 'Preferences updated' })
}
