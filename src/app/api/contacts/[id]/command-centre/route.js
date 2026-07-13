// GET /api/contacts/[id]/command-centre
//
// UIX-P2 — one-round-trip bundle for the unified inbox's contact
// command centre: the contact row + their recent activity timeline.
// Consent state + audit lines come from the existing sibling routes
// (marketing-preferences, consent-log) so the consent semantics stay
// in exactly one place.
//
// DRAWER.2 — `?scope=drawer` extends the bundle (additively — the base
// shape is untouched for CommandCentre.jsx) with what the pipeline
// contact drawer needs in one round trip: recent notes, active
// sequence enrollments, the latest WhatsApp window state, the
// composer's sendable UTILITY templates, and the caller's channel
// permissions.
//
// IDOR gate mirrors consent-log: resolve the contact's studio, check
// it against the caller's locations, and answer 404 (not 403) on a
// miss so contact ids can't be enumerated.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ACTIVITIES = 20

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: contact, error } = await db
    .from('contacts')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Activities + bookable event types in one parallel pass. The
  // event-types list powers the Book tab (UIX-P3a) — the existing
  // /api/bookings/event-types list route is API-key-only (n8n), so
  // the session-authed bundle carries it instead.
  const [actRes, etRes] = await Promise.all([
    db.from('activities')
      .select('*')
      .eq('contact_id', params.id)
      .order('created_at', { ascending: false })
      .limit(MAX_ACTIVITIES),
    db.from('event_types')
      .select('id, name, slug, duration_minutes, availability, active')
      .eq('location_id', contact.location_id)
      .eq('active', true)
      .order('name', { ascending: true }),
  ])
  if (actRes.error) {
    return NextResponse.json({ success: false, error: actRes.error.message }, { status: 500 })
  }

  // DRAWER.2 — extra fields for the pipeline contact drawer only, so
  // the inbox's base bundle stays exactly as cheap as before.
  const scope = new URL(request.url).searchParams.get('scope')
  let drawerExtras = null
  if (scope === 'drawer') {
    const [notesRes, seqRes, waRes] = await Promise.all([
      db.from('notes')
        .select('*')
        .eq('contact_id', params.id)
        .order('created_at', { ascending: false })
        .limit(MAX_ACTIVITIES),
      db.from('sequence_enrollments')
        .select('id, next_step_at, email_sequences(name)')
        .eq('contact_id', params.id)
        .eq('status', 'active')
        .order('next_step_at', { ascending: true }),
      db.from('whatsapp_conversations')
        .select('id, window_expires_at, last_message_at')
        .eq('contact_id', params.id)
        .order('last_message_at', { ascending: false })
        .limit(1),
    ])
    const latestWa = (waRes.data || [])[0] || null

    // Composer template list — the same UTILITY + APPROVED +
    // isSendableUtilityTemplate chain the contact page builds, only
    // when the caller can send WhatsApp at all.
    let composerTemplates = []
    const canWhatsApp = hasPermission(user, 'whatsapp')
    if (canWhatsApp) {
      const { data: rawTemplates } = await db
        .from('whatsapp_templates')
        .select('name, language, components, status, category')
        .eq('location_id', contact.location_id)
        .eq('category', 'UTILITY')
        .eq('status', 'APPROVED')
        .order('name', { ascending: true })
      composerTemplates = (rawTemplates || [])
        .filter(isSendableUtilityTemplate)
        .map((t) => ({
          name: t.name,
          language: t.language || 'en',
          bodyText: extractTemplateBody(t.components).bodyText,
          sendable: true,
        }))
    }

    drawerExtras = {
      notes: notesRes.data || [],
      sequences: seqRes.data || [],
      wa: {
        window_open: latestWa?.window_expires_at
          ? new Date(latestWa.window_expires_at) > new Date()
          : false,
        window_expires_at: latestWa?.window_expires_at || null,
      },
      composer_templates: composerTemplates,
      permissions: {
        whatsapp: canWhatsApp,
        sms: hasPermission(user, 'sms'),
        email: hasPermission(user, 'email'),
      },
    }
  }

  return NextResponse.json({
    success: true,
    contact,
    activities: actRes.data || [],
    event_types: etRes.data || [],
    ...(drawerExtras || {}),
  })
}
