import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'

const PreferencesUpdateSchema = z.object({
  email_marketing: z.boolean().optional(),
  email_administrative: z.boolean().optional(),
  whatsapp_marketing: z.boolean().optional(),
  whatsapp_administrative: z.boolean().optional(),
  // SMS toggles (mig 063 added administrative; mig 064 added marketing).
  sms_marketing: z.boolean().optional(),
  sms_administrative: z.boolean().optional(),
})

export const runtime = 'nodejs'

// 20 attempts per IP per 15 minutes. The preference centre legitimately
// sends a few requests per session (load + toggle a few channels), so this
// is more lenient than the unsubscribe endpoint while still blunting any
// brute-force enumeration.
const RL = { max: 20, windowMs: 15 * 60_000 }

// GET /api/preferences/[token] — fetch current preferences
export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `preferences:${ip}`, RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
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
      sms_marketing: pref.sms_marketing,
      sms_administrative: pref.sms_administrative,
    },
  })
}

// PUT /api/preferences/[token] — update preferences
export async function PUT(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `preferences:${ip}`, RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  const validation = await validateBody(request, PreferencesUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  const allowed = [
    'email_marketing', 'email_administrative',
    'whatsapp_marketing', 'whatsapp_administrative',
    'sms_marketing', 'sms_administrative',
  ]
  const updates = {}
  const logEntries = []

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
    const contactUpdate = { email_status: updates.email_marketing ? 'active' : 'unsubscribed' }
    // EMAIL-HYGIENE.1 — explicit re-consent also clears the engagement-
    // hygiene suppression stamp (contacts.email_suppressed_at, mig 395):
    // a contact actively saying "send me marketing" outranks our
    // 90-day-non-opener call. Opt-out leaves the stamp alone (the consent
    // gate already excludes them; if they re-consent later this branch
    // clears it then).
    if (updates.email_marketing === true) contactUpdate.email_suppressed_at = null
    await db
      .from('contacts')
      .update(contactUpdate)
      .eq('id', pref.contact_id)
  }

  return NextResponse.json({ success: true, message: 'Preferences updated' })
}
