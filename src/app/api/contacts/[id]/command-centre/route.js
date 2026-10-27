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
// IDOR gate: the contact page's rule (canViewContact: a member of the
// contact's studio, a crossover viewer whose studio holds a contact_studios
// row for the person, or a master), answering 404 (not 403) on a miss so
// contact ids can't be enumerated. CARDLENS-M.1 — it used to be membership of
// the contact's studio only, so a Hatch Street coach opening a
// Stillorgan-primary Hatch member on the phone got a 404 here: no timeline and
// no buttons, while the web page opened. A crossover viewer gets what the web
// page shows them: the bookable event types (the Book tab, membership only on
// the web) stay off, and the channel and kudos flags, judged at the contact's
// studio, come out false.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { contactChannelFlags, canLoadContactConsultations, isMemberOfContactStudio } from '@/lib/contact-page-gates'
import { canViewContact } from '@/lib/contact-crossovers'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'
import { classifyContact, scoreMember } from '@/lib/churn-radar'
import { loadContactArrears } from '@/lib/churn-radar-data'
import { loadUn1tBilling } from '@/lib/contact-un1t-billing'

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
  const isMember = isMemberOfContactStudio(user, contact.location_id)
  if (!isMember && !(await canViewContact(db, user, contact))) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Activities + bookable event types + triage signals in one parallel
  // pass. The event-types list powers the Book tab (UIX-P3a) — the
  // existing /api/bookings/event-types list route is API-key-only,
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

  // HATCHPIPE.2 — un1t.online billing joins the same pass. loadUn1tBilling
  // never rejects and already narrows to the studios where the viewer holds
  // Contacts (the 404 gate above is unchanged).
  const [actRes, etRes, arrears, latestNote, un1tBilling] = await Promise.all([
    db.from('activities')
      .select('*')
      .eq('contact_id', params.id)
      .order('created_at', { ascending: false })
      .limit(MAX_ACTIVITIES),
    isMember
      ? db.from('event_types')
        .select('id, name, slug, duration_minutes, availability, active')
        .eq('location_id', contact.location_id)
        .eq('active', true)
        .order('name', { ascending: true })
      : { data: [], error: null },
    loadContactArrears(db, params.id),
    fetchLatestNote(),
    loadUn1tBilling(db, user, params.id),
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
  // An un1t.online overdue is the same 'overdue' class a Glofox past-due
  // gets, so the label, the null tier and CommandCentre's red chip all follow
  // from the one existing branch below.
  const churnClass = un1tBilling.overdue ? 'overdue' : classifyContact(contact, churnCtx)
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

  // The panel's own shape: only the studios with an overdue row (each named
  // once, at its earliest `since`), and the EUR sum alone (another currency is
  // never added to it; 0 when no amount is known).
  const earliestSince = (rows) => rows.reduce((min, r) => {
    const ms = Date.parse(r?.since)
    if (!Number.isFinite(ms)) return min
    return min === null || ms < Date.parse(min) ? r.since : min
  }, null)
  const un1tBillingOut = {
    overdue: un1tBilling.overdue,
    arrears_cents: Number(un1tBilling.arrearsCentsByCurrency?.EUR) || 0,
    amount_unreported: un1tBilling.amountUnreported === true,
    amount_not_eur: un1tBilling.amountNotEur === true,
    studios: (un1tBilling.studios || [])
      .filter((s) => s.pastDues?.length > 0)
      .map((s) => ({ location_id: s.locationId, since: earliestSince(s.pastDues) })),
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
      // WAORGNUMBER.4 (R3) — the composer sends on the HOME studio's thread,
      // so its window is the one the drawer shows.
      db.from('whatsapp_conversations')
        .select('id, window_expires_at, last_message_at')
        .eq('contact_id', params.id)
        .eq('location_id', contact.location_id)
        .order('last_message_at', { ascending: false })
        .limit(1),
    ])
    const latestWa = (waRes.data || [])[0] || null

    // Composer template list — the same UTILITY + APPROVED +
    // isSendableUtilityTemplate chain the contact page builds, only
    // when the caller can send WhatsApp at all.
    let composerTemplates = []
    // ROLESWEEP.1c — the drawer's channel flags are the send routes' own
    // decision: the web OR the mobile toggle at the CONTACT's location (the
    // composer sends from there), not the active studio. The contact page
    // reads the same helper, so the two composers agree.
    const channels = contactChannelFlags(user, contact.location_id)
    if (channels.whatsapp) {
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
      // ROLEUI.1 — `kudos` is POST /api/contacts/[id]/kudos's decision (the
      // web `consultations` permission at the contact's location). The staff
      // phone's contact screen reads every flag here instead of judging its
      // buttons at the active studio.
      permissions: { ...channels, kudos: canLoadContactConsultations(user, contact.location_id) },
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
    un1t_billing: un1tBillingOut,
    ...(drawerExtras || {}),
  })
}
