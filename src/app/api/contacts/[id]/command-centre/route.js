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
import { classifyContact, scoreMember } from '@/lib/churn-radar'
import { loadContactArrears } from '@/lib/churn-radar-data'

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

  // Activities + bookable event types + triage signals in one parallel
  // pass. The event-types list powers the Book tab (UIX-P3a) — the
  // existing /api/bookings/event-types list route is API-key-only (n8n),
  // so the session-authed bundle carries it instead.
  //
  // INBOX-REDESIGN.4.1 — arrears + latest note join the same pass: both
  // are independent of activities/event_types (and of each other), so
  // there's no reason to wait on them sequentially. loadContactArrears
  // mirrors the contact page's PROFILE-ARREARS.1 read (netted, safe — no
  // migration, existing glofox_invoices data) and never rejects (it has
  // its own internal try/catch). The notes read is wrapped in its own
  // async helper with try/catch — builders are thenables, not Promises
  // (`.catch()` on the builder itself throws, per this repo's CLAUDE.md),
  // so this is the safe way to make a best-effort read a Promise.all
  // member: a notes-table hiccup resolves to null instead of failing
  // the whole panel.
  const fetchLatestNote = async () => {
    try {
      const { data } = await db.from('notes')
        .select('content, created_at')
        .eq('contact_id', params.id)
        .order('created_at', { ascending: false })
        .limit(1)
      return data?.[0] ?? null
    } catch {
      return null
    }
  }

  const [actRes, etRes, arrears, latestNote] = await Promise.all([
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
    loadContactArrears(db, params.id),
    fetchLatestNote(),
  ])
  if (actRes.error) {
    return NextResponse.json({ success: false, error: actRes.error.message }, { status: 500 })
  }

  // Churn classification/scoring runs only AFTER arrears has resolved —
  // classifyContact's 'overdue' branch is gated on ctx.pastDueIds, which
  // is built FROM arrears.count, so the ordering is load-bearing (see
  // classifyContact in src/lib/churn-radar.js). Both helpers are pure/
  // sync; this mirrors src/app/contacts/[id]/page.js's CHURN-CONTACT.1 /
  // PROFILE-ARREARS.1 pattern exactly (there: activityContact + arrearsCtx
  // → churnClass → churnScored), minus the person-group activity merge —
  // out of scope here; no migration/new data source either way.
  const churnCtx = arrears.count > 0 ? { pastDueIds: new Set([params.id]) } : {}
  const churnClass = classifyContact(contact, churnCtx)
  const scored = churnClass === 'active' ? scoreMember(contact, Date.now()) : null
  let churnLabel = null
  let churnTier = null
  if (churnClass === 'overdue') {
    churnLabel = 'Payment overdue'
  } else if (scored?.tier === 'high') {
    churnLabel = 'At risk · High'
    churnTier = 'high'
  } else if (scored?.tier === 'medium') {
    churnLabel = 'At risk · Medium'
    churnTier = 'medium'
  } else if (scored) {
    churnLabel = 'At risk'
    churnTier = 'low'
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
    // INBOX-REDESIGN.4.1 — triage signals for the inbox contact panel, in
    // the BASE payload (unlike drawerExtras) so the unscoped panel gets
    // them without needing ?scope=drawer.
    signals: {
      churnClass,
      churnLabel,
      churnTier,
      arrearsCents: arrears.arrearsCents,
      arrearsCount: arrears.count,
      visits30: contact.total_attended_30d ?? 0,
      lastAttendedAt: contact.last_attended_at ?? null,
    },
    latestNote,
    ...(drawerExtras || {}),
  })
}
