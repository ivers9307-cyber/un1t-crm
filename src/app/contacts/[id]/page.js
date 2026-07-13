import { createServerClient } from '@/lib/supabase'
import { matchCatalogToPlan } from '@/lib/glofox-catalog'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Mail, Phone, MessageSquare, CheckSquare, Clock, MessageCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { dublinTodayStr } from '@/lib/dublin-time'
import { canViewContact } from '@/lib/contact-crossovers'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import { classifyContact, scoreMember } from '@/lib/churn-radar'
import { loadContactArrears } from '@/lib/churn-radar-data'
import { loadContactJourney } from '@/lib/onboarding-journey-data'
import ContactActions from '@/components/ContactActions'
import ContactComposer from '@/components/ContactComposer'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'
import StartWhatsAppButton from '@/components/StartWhatsAppButton'
import ContactRaceHistory from '@/components/ContactRaceHistory'
import ContactEditDeleteActions from '@/components/ContactEditDeleteActions'
import InviteToAppButton from '@/components/InviteToAppButton'
import MemberPasswordOverrideButton from '@/components/MemberPasswordOverrideButton'
import ContactDevicesCard from '@/components/ContactDevicesCard'
import ContactMarketingPreferencesCard from '@/components/ContactMarketingPreferencesCard'
import ContactConsentHistoryCard from '@/components/ContactConsentHistoryCard'
import GlofoxProfileCard from '@/components/contact/GlofoxProfileCard'
import { relativeTime, formatMoney, formatTime } from '@/components/contact/format'
// PERSON-LINK.1 — unified person identity view (mig 270 tables).
import { getPersonGroup } from '@/lib/person-links'
import { aggregatePerson } from '@/lib/person-aggregate'
import PersonHeader from '@/components/PersonHeader'
import PersonActionBar from '@/components/PersonActionBar'
import LinkedAccountsCard from '@/components/LinkedAccountsCard'
import ContactDetailTabs from '@/components/ContactDetailTabs'
import ContactTimeline from '@/components/contact/ContactTimeline'
import { mergeTimeline } from '@/lib/contact-view'
import { formatLastSeen } from '@/lib/person-view'
// CONSULTATIONS SP1 — coach/web surface (mig 272 tables), permission-gated.
import ContactGoalsCard from '@/components/ContactGoalsCard'
import ConsultationsList from '@/components/ConsultationsList'
import SendKudosCard from '@/components/SendKudosCard'
import ProgressPhotos from '@/components/ProgressPhotos'
import InBodyProgress from '@/components/InBodyProgress'

export const dynamic = 'force-dynamic'

// DRAWER.3 — the timeline's activityIcons map + both render variants
// (grouped person / single contact) moved to
// src/components/contact/ContactTimeline.jsx, shared with the pipeline
// contact drawer.

// PULSE-90.4 — first-90-days journey status chips. Light-theme contrast
// recipe (bg-<c>-500/10 text-<c>-700 — never the -300/-400 ramp): on_track +
// completed emerald, behind amber, at_risk red, expired neutral grey.
const PULSE_STATUS_CHIP = {
  on_track:  'bg-emerald-500/10 text-emerald-700',
  completed: 'bg-emerald-500/10 text-emerald-700',
  behind:    'bg-amber-500/10 text-amber-700',
  at_risk:   'bg-red-500/10 text-red-700',
  expired:   'bg-gray-500/10 text-gray-600',
}
const PULSE_STATUS_LABEL = {
  on_track:  'On track',
  completed: 'Completed',
  behind:    'Behind',
  at_risk:   'At risk',
  expired:   'Window over',
}

export default async function ContactDetailPage(props) {
  const params = await props.params;
  const db = createServerClient()
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const { id } = params

  // IDOR gate (2026-06 platform audit, same lineage as the consent-log /
  // sms / whatsapp routes). This page renders via createServerClient()
  // (service role — RLS does NOT bind it), so without an app-layer check
  // any authenticated user could read any contact's full profile —
  // membership, LTV, DOB, message history — by enumerating ids. Load the
  // contact FIRST, authorise, and only THEN fetch its sub-resources, so a
  // stranger's deals / notes / bookings / WhatsApp are never queried at
  // all. canViewContact allows owned ∪ crossover (a deal at the caller's
  // studio) ∪ master, mirroring the contacts list so crossover rows the
  // operator can see stay openable.
  const { data: contact } = await db.from('contacts').select('*').eq('id', id).single()
  if (!contact) notFound()
  if (!(await canViewContact(db, user, contact))) notFound()

  // PERSON-LINK.1 — unified person view, best-effort. getPersonGroup
  // queries the mig-270 tables; wrap so a contact with no group (the
  // norm — ~99% of contacts) OR a not-yet-applied migration both fall
  // back cleanly to the single-account view instead of crashing the
  // page. We deliberately do NOT add person_group_id to the main contact
  // SELECT above (that column may not exist pre-migration); the try/catch
  // here is the safe path.
  let person = null
  try {
    const pg = await getPersonGroup(db, contact.id)
    if (pg?.group?.id) person = await aggregatePerson(db, pg.group.id)
  } catch { person = null }

  const [dealsRes, notesRes, activitiesRes, bookingsRes, waConvRes, contactArrears] = await Promise.all([
    db.from('deals').select('*, pipeline_stages(name, color)').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('notes').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('activities').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('bookings').select('*, event_types(name, color)').eq('contact_id', id).order('booking_date', { ascending: true }),
    db.from('whatsapp_conversations').select('id, wa_phone, last_message_at, last_message_preview, last_message_direction, unread_count, status, window_expires_at').eq('contact_id', id).order('last_message_at', { ascending: false }),
    // PROFILE-ARREARS.1 — this contact's open past-due total (netted), so the
    // profile shows the SAME arrears the Overdue chase-list flags. Previously
    // arrears were only computed for grouped contacts, so an ungrouped member
    // in arrears showed "—" and the overdue pill never lit (no pastDueIds ctx).
    loadContactArrears(db, id),
  ])

  // GLOFOX-CATALOG — resolve the member's plan description (pricing +
  // commitment terms) from the studio membership catalog by plan name.
  // Current-catalog plans resolve; archived/promo plans Glofox no longer
  // returns won't, and we just show the plan name without terms.
  if (contact.glofox_membership_plan && contact.location_id) {
    const { data: catalogRows } = await db.from('glofox_memberships')
      .select('name_clean, plan_names, description')
      .eq('location_id', contact.location_id)
    const catMatch = matchCatalogToPlan(catalogRows || [], {
      plan: contact.glofox_membership_plan,
      planFull: contact.glofox_membership_plan_full,
    })
    if (catMatch?.description) contact.membership_description = catMatch.description
  }

  const deals = dealsRes.data || []
  const notes = notesRes.data || []
  const activities = activitiesRes.data || []
  const bookings = bookingsRes.data || []
  const waConversations = waConvRes.data || []

  // CHURN-CONTACT.1 — make the contact page prospective, not just a
  // retrospective timeline: surface the SAME at-risk signal the radar
  // uses (so it follows the person), and what's queued to happen next.
  // classifyContact / scoreMember are pure; contacts.* carries the
  // attendance + membership fields they need.
  //
  // PERSON-LINK.1 (activity-aware) — when the contact is grouped, merge
  // the COMBINED activity across all linked accounts into the contact used
  // for classification. This ensures the at-risk/churn chip reflects the
  // person's most-recent activity (not just the primary account). The
  // primary contact itself is unchanged for outreach purposes.
  const activityContact = person
    ? { ...contact, last_attended_at: person.lastAttendedAt, total_attended_30d: person.attended }
    : contact
  // PROFILE-ARREARS.1 — supply the past-due context classifyContact needs to
  // light the "Payment overdue" pill. Without it the overdue branch (guarded on
  // ctx.pastDueIds) can never fire here, so a member the Overdue chase-list
  // flags showed no overdue signal on their own profile.
  const arrearsCtx = contactArrears.count > 0 ? { pastDueIds: new Set([activityContact.id]) } : {}
  const churnClass = classifyContact(activityContact, arrearsCtx)
  const churnScored = churnClass === 'active' ? scoreMember(activityContact, Date.now()) : null
  let risk = null
  if (churnClass === 'overdue') {
    risk = { label: 'Payment overdue', cls: 'bg-red-50 text-red-700 border-red-200', title: 'Membership locked in Glofox — on the Overdue chase-list.' }
  } else if (churnScored) {
    const sigs = churnScored.signals.map((s) => `${s.label}: ${s.detail}`).join(' · ')
    risk = churnScored.tier === 'high'
      ? { label: 'At risk · High', cls: 'bg-red-50 text-red-700 border-red-200', title: sigs }
      : { label: churnScored.tier === 'medium' ? 'At risk · Medium' : 'At risk', cls: 'bg-amber-50 text-amber-700 border-amber-200', title: sigs }
  }

  // PULSE-90.4 — first-90-days journey. loadContactJourney returns null for
  // anyone not currently in their onboarding window (no joined_at, past the
  // tail, or expired without completing), so the compact block below only
  // renders for in-window members. Best-effort — a failed read (or a DB
  // without the journey data) must not blank the profile.
  let journey = null
  try {
    journey = await loadContactJourney(db, id)
  } catch { journey = null }

  const [seqRes, emailRes, smsRes] = await Promise.all([
    db.from('sequence_enrollments')
      .select('id, next_step_at, email_sequences(name)')
      .eq('contact_id', id)
      .eq('status', 'active')
      .order('next_step_at', { ascending: true }),
    // CONTACT-MSG.1 — email send history (campaigns + sequences) with
    // Postmark delivery/engagement state, so "what have we emailed and
    // did it land?" is answerable without leaving the contact page.
    db.from('email_sends')
      .select('id, created_at, source_type, subject, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, bounce_type, complained_at')
      .eq('contact_id', id)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(8),
    // SMS broadcast sends (ad-hoc / sequence SMS aren't logged per-contact).
    db.from('sms_broadcast_recipients')
      .select('id, status, sent_at, delivered_at, failed_at, undelivered_at, error_message, sms_broadcasts(name)')
      .eq('contact_id', id)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(8),
  ])
  const activeSequences = seqRes.data || []
  const messages = buildMessageHistory(emailRes.data || [], smsRes.data || [])

  // CONTACT-COMPOSER.1 — messaging context for the unified composer.
  const canWhatsApp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  // DRAWER.4 — ad-hoc email channel (same gate as the /email route).
  const canEmail = hasPermission(user, 'email')
  const latestWaConversation = waConversations[0] || null
  const whatsappWindowOpen = latestWaConversation?.window_expires_at
    ? new Date(latestWaConversation.window_expires_at) > new Date()
    : false
  // Approved WhatsApp UTILITY templates the composer offers once the
  // 24h window has closed. Loaded only when the caller can WhatsApp.
  let composerTemplates = []
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

  // CONSULTATIONS SP1 — coach/web surface. Loaded only when the caller
  // holds the `consultations` permission; otherwise the tab is omitted
  // entirely (and we never query the sub-resources). The page already
  // runs through createServerClient() (service role — RLS doesn't bind
  // it), so the permission check IS the access gate here, mirroring the
  // goals/consultations/photos API routes.
  const canConsultations = hasPermission(user, 'consultations')
  let consultationsTab = null
  if (canConsultations) {
    const [consultsRes, goalsRes, photosRes, scansRes, coachLinksRes] = await Promise.all([
      db.from('consultations').select('*').eq('contact_id', contact.id).order('consulted_at', { ascending: false }),
      db.from('coaching_goals').select('*').eq('contact_id', contact.id).order('created_at', { ascending: false }),
      db.from('consultation_photos').select('*').eq('contact_id', contact.id).order('taken_at', { ascending: false }),
      db.from('inbody_scans').select('*').eq('contact_id', contact.id).order('scanned_at', { ascending: false }),
      // Location staff for the coach <select> + name resolution. The
      // permissions JSONB isn't needed here, so a slim join is fine.
      db.from('profile_locations')
        .select('profiles:profile_id ( id, full_name )')
        .eq('location_id', contact.location_id),
    ])

    const consultations = consultsRes.data || []
    const contactGoals = goalsRes.data || []
    const inbodyScans = scansRes.data || []

    // De-dupe + shape the coach list ([{id, name}]). A profile can be
    // assigned to the location more than once historically; key on id.
    const coachMap = new Map()
    for (const row of coachLinksRes.data || []) {
      const p = row.profiles
      if (p?.id && !coachMap.has(p.id)) coachMap.set(p.id, { id: p.id, name: p.full_name || 'Coach' })
    }
    const coaches = [...coachMap.values()].sort((a, b) => a.name.localeCompare(b.name))

    // Generate a 600s signed URL per photo (private bucket) and attach it
    // as `url` for the gallery. Best-effort per photo — a failed sign just
    // drops that thumbnail rather than crashing the tab.
    const rawPhotos = photosRes.data || []
    const photos = await Promise.all(rawPhotos.map(async (p) => {
      let url = null
      try {
        const { data: signed } = await db.storage
          .from('consultation-photos')
          .createSignedUrl(p.storage_path, 600)
        url = signed?.signedUrl ?? null
      } catch {
        url = null
      }
      return { id: p.id, url, taken_at: p.taken_at, label: p.label, caption: p.caption }
    }))
    const signedPhotos = photos.filter((p) => p.url)

    consultationsTab = (
      <div className="space-y-5">
        <SendKudosCard contactId={contact.id} />
        <ContactGoalsCard contactId={contact.id} goals={contactGoals} />
        <ConsultationsList
          contactId={contact.id}
          consultations={consultations}
          coaches={coaches}
          currentUserId={user.id}
        />
        <ProgressPhotos contactId={contact.id} photos={signedPhotos} />
        <InBodyProgress scans={inbodyScans} contactId={contact.id} />
      </div>
    )
  }

  const today = dublinTodayStr()
  const upcomingBookings = bookings.filter(b => b.booking_date >= today && b.status === 'confirmed')
  const pastBookings = bookings.filter(b => b.booking_date < today || b.status !== 'confirmed')

  // Build unified timeline from notes + activities, sorted by date
  // (DRAWER.1 — the merge moved to contact-view so the drawer shares it).
  const timeline = mergeTimeline(notes, activities)

  // Note: the pipeline_stage_slug pill is now rendered by <PersonHeader>
  // (its own STAGE_PILL map, on the -700 light-theme ramp) — the old
  // local `statusColors` map this page kept was removed with the rewire.

  const bookingStatusColors = {
    confirmed: 'bg-blue-500/20 text-blue-700',
    completed: 'bg-green-500/20 text-green-700',
    cancelled: 'bg-red-500/20 text-red-700',
    no_show: 'bg-yellow-500/20 text-yellow-700',
  }

  // PERSON-LINK.1 — at-a-glance lifetime metrics. Prefer the unified
  // person aggregate when the contact is grouped, else fall back to the
  // single-contact figures the page already loaded.
  //  - arrears (PROFILE-ARREARS.1): grouped contacts use the cross-account
  //    aggregate; ungrouped contacts use the per-contact figure (netted, same
  //    source as the Overdue chase-list) so a member in arrears shows their
  //    real total here instead of "—".
  //  - lifetime value: not aggregated cross-account (the codebase has no
  //    cross-member LTV roll-up), so we keep the primary contact's figure
  //    in both the grouped and single case.
  const ltvCents = contact.lifetime_value_cents
  const metricArrearsCents = person ? person.arrearsCents : contactArrears.arrearsCents
  const metricAttended = person ? person.attended : (Number(contact.total_attended_30d) || 0)
  const metricDeals = person ? person.dealsCount : deals.length

  // Identity contact rows (emails + phones). When grouped, render the
  // deduped cross-account lists from the aggregate; else the contact's
  // own email / phone(s).
  const identityEmails = person
    ? person.emails
    : (contact.email ? [{ value: contact.email, sourceContactId: contact.id, contactable: true }] : [])
  const identityPhones = person
    ? person.phones
    : [contact.phone, contact.wa_phone]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .map((v) => ({ value: v, sourceContactId: contact.id }))

  // ── Tab content ──────────────────────────────────────────────────────────

  const overviewTab = (
    <div className="space-y-5">
      {/* PERSON-LINK.1 — linked accounts (or "not linked" CTA when single). */}
      <LinkedAccountsCard person={person} contactId={contact.id} locationId={contact.location_id} />

      {/* Identity — emails + phones (deduped across the group when linked). */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Identity</h3>
        <div className="space-y-1.5">
          {identityEmails.length === 0 && identityPhones.length === 0 && (
            <p className="text-sm text-un1t-muted">No contact details</p>
          )}
          {identityEmails.map((e) => (
            <div key={`em-${e.value}`} className="flex items-center gap-2 text-sm text-un1t-text">
              <Mail size={14} className="text-un1t-subtle shrink-0" />
              <span className="truncate">{e.value}</span>
              {e.contactable === false && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-700">
                  Not contactable
                </span>
              )}
            </div>
          ))}
          {identityPhones.map((p) => (
            <div key={`ph-${p.value}`} className="flex items-center gap-2 text-sm text-un1t-text">
              <Phone size={14} className="text-un1t-subtle shrink-0" />
              <span className="truncate">{p.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Key metrics — lifetime value / arrears / attended (30d) / deals.
          Uses the person aggregate when grouped, single-contact figures
          otherwise. */}
      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Lifetime value" value={formatMoney(ltvCents, contact.lifetime_currency) || '—'} />
        <MetricCard
          label="Arrears"
          value={metricArrearsCents != null ? (formatMoney(metricArrearsCents, contact.lifetime_currency) || '—') : '—'}
          tone={metricArrearsCents > 0 ? 'danger' : 'default'}
        />
        <MetricCard label="Attended (30d)" value={metricAttended} />
        <MetricCard label="Deals" value={metricDeals} />
      </div>

      {/* PERSON-LINK.1 (activity-aware) — combined last attended.
          When grouped, shows the MAX last_attended_at across all accounts
          so a ClassPass-active person with a dormant primary doesn't look
          quiet. For ungrouped contacts falls back to the contact's own
          field. Hidden when both are null (no attendance data at all). */}
      {(person?.lastAttendedAt || contact.last_attended_at) && (
        <p className="text-xs text-un1t-subtle px-1">
          Last attended: <span className="font-medium text-un1t-text">
            {formatLastSeen(person ? person.lastAttendedAt : contact.last_attended_at)}
          </span>
          {person && person.accounts.length > 1 && (
            <span className="text-un1t-muted"> (across all accounts)</span>
          )}
        </p>
      )}

      {/* PULSE-90.4 — first-90-days journey. Compact block shown while a
          member is inside their onboarding window (guarded on inWindow, so a
          finisher's block clears once the window ends rather than reading
          "Day 50/42"). Day X / windowDays, attended / target, and a status
          chip on the light-theme contrast ramp (bg-<c>-500/10 text-<c>-700).
          The full lane + "Log touch" live on /pulse. */}
      {journey?.inWindow && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">First 90 days</h3>
            <span className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${PULSE_STATUS_CHIP[journey.status] || 'bg-gray-500/10 text-gray-600'}`}>
              {PULSE_STATUS_LABEL[journey.status] || journey.status}
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <div>
              <div className="text-un1t-muted text-[11px] uppercase tracking-wider">Day</div>
              <div className="text-un1t-text font-medium">{journey.dayIndex}/{journey.windowDays}</div>
            </div>
            <div>
              <div className="text-un1t-muted text-[11px] uppercase tracking-wider">Classes</div>
              <div className="text-un1t-text font-medium">{journey.attended}/{journey.target}</div>
            </div>
          </div>
        </div>
      )}

      {/* Info Card. GLOFOX2.9 — Glofox-specific fields (credits,
          glofox_member_id) moved to the dedicated Glofox Profile
          card below. This card now only carries CRM-native
          identifiers. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Details</h3>
        <InfoRow label="Source" value={contact.lead_source || contact.source} />
        <InfoRow label="Label" value={contact.label || '—'} />
        <InfoRow label="Created" value={new Date(contact.created_at).toLocaleDateString('en-IE')} />
      </div>

      {/* GLOFOX2.9 — consolidated Glofox Profile card. Always
          rendered because every CRM contact should also exist in
          Glofox under the bidirectional-sync model (Glofox is
          source of truth for users). When not yet linked
          (glofox_member_id null), the card shows a "not yet
          synced" empty state instead of being hidden. */}
      <GlofoxProfileCard contact={contact} />

      {/* CHURN-CONTACT.1 — Active sequences: what's queued to happen
          next. The timeline (Activity tab) shows what already happened;
          this shows what's coming, so you can see (and not double-enrol)
          an automation already running for this contact. */}
      {activeSequences && activeSequences.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
            <Clock size={12} /> Active sequences
          </h3>
          {activeSequences.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b border-un1t-border last:border-0">
              <span className="text-sm">{s.email_sequences?.name || 'Sequence'}</span>
              <span className="text-xs text-un1t-muted whitespace-nowrap">
                {s.next_step_at ? `next ${relativeTime(s.next_step_at)}` : 'queued'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const activityTab = (
    <div className="space-y-5">
      {/* Timeline. PERSON-LINK.1 — when grouped, render the unified
          cross-account timeline from the aggregate (tagged by source
          account when there are multiple); otherwise the single
          contact's notes + activities timeline the page already built. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg">
        <div className="flex items-center justify-between p-4 border-b border-un1t-border">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Timeline</h3>
          <ContactActions
            contactId={contact.id}
            locationId={contact.location_id}
          />
        </div>
        <ContactTimeline timeline={timeline} person={person} />
      </div>

      {/* Deals */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Deals</h3>
        {deals.length === 0 && <p className="text-sm text-un1t-muted">No deals</p>}
        {deals.map(deal => (
          <div key={deal.id} className="flex items-center justify-between py-2 border-b border-un1t-border last:border-0">
            <span className="text-sm">{deal.title}</span>
            <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: deal.pipeline_stages?.color + '30', color: deal.pipeline_stages?.color }}>
              {deal.pipeline_stages?.name}
            </span>
          </div>
        ))}
      </div>

      {/* CRM-native event registrations — workshops, masterclasses,
          open days, races (the /events flow). Distinct from Glofox
          class bookings which appear in the Glofox Profile card.
          Only render when there's something to show (avoids
          empty-state clutter for trial members). */}
      {(upcomingBookings.length > 0 || pastBookings.length > 0) && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Upcoming event registrations</h3>
        {upcomingBookings.length === 0 && <p className="text-sm text-un1t-muted">None</p>}
        {upcomingBookings.map(b => (
          <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-border last:border-0">
            <div
              className="w-1 h-8 rounded-full mt-0.5 shrink-0"
              style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{b.event_types?.name || 'Event'}</p>
              <p className="text-xs text-un1t-subtle mt-0.5">
                {new Date(b.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}
                {' · '}
                {formatTime(b.start_time)} — {formatTime(b.end_time)}
              </p>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full ${bookingStatusColors[b.status]}`}>
              {b.status}
            </span>
          </div>
        ))}
      </div>
      )}

      {/* Race history (mig 086). Surfaces every race this contact
          has competed in — captain or member — with team, wave,
          and finish time. Always rendered; the component shows
          a "no races yet" message when empty. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Races</h3>
        <ContactRaceHistory contactId={contact.id} />
      </div>

      {/* Past event registrations (CRM-native). */}
      {pastBookings.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Past event registrations</h3>
          {pastBookings.map(b => (
            <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-border last:border-0 opacity-60">
              <div
                className="w-1 h-8 rounded-full mt-0.5 shrink-0"
                style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm">{b.event_types?.name || 'Event'}</p>
                <p className="text-xs text-un1t-subtle mt-0.5">
                  {new Date(b.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
                  {' · '}
                  {formatTime(b.start_time)}
                </p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${bookingStatusColors[b.status]}`}>
                {b.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Open tasks — manual to-dos only (mig 073).
          Auto-logged events live on the timeline above. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Open tasks</h3>
        {activities.filter(a => a.kind === 'task' && !a.done).length === 0 && (
          <p className="text-sm text-un1t-muted">No open tasks</p>
        )}
        {activities.filter(a => a.kind === 'task' && !a.done).map(a => (
          <div key={a.id} className="flex items-start gap-2 py-2 border-b border-un1t-border last:border-0">
            <CheckSquare size={14} className="text-un1t-muted mt-0.5 shrink-0" />
            <div>
              <p className="text-sm">{a.subject}</p>
              {a.due_date && (
                <p className="text-xs text-un1t-subtle flex items-center gap-1 mt-0.5">
                  <Clock size={10} /> {a.due_date} {a.due_time ? formatTime(a.due_time) : ''}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  const commsTab = (
    <div className="space-y-5">
      {/* Quick WhatsApp start action. */}
      <div className="flex items-center gap-3">
        <StartWhatsAppButton
          contactId={contact.id}
          contactPhone={contact.phone}
          waPhone={contact.wa_phone}
        />
      </div>

      {/* #message anchor — PersonActionBar's "Message" action deep-links
          here (/contacts/[id]#message) so it lands on the composer. */}
      <div id="message" className="scroll-mt-4">
        <ContactComposer
          contactId={contact.id}
          contactName={contact.first_name || contact.name}
          canWhatsApp={canWhatsApp}
          canSms={canSms}
          canEmail={canEmail}
          hasWaPhone={!!(contact.wa_phone || contact.phone)}
          hasPhone={!!contact.phone}
          hasEmail={!!contact.email}
          smsBlocked={!!(contact.sms_status && contact.sms_status !== 'active')}
          emailBlocked={['bounced', 'complained', 'unsubscribed'].includes(contact.email_status)}
          whatsappWindowOpen={whatsappWindowOpen}
          whatsappWindowExpiresAt={latestWaConversation?.window_expires_at || null}
          templates={composerTemplates}
        />
      </div>

      {/* CONTACT-MSG.1 — Messages: what we've emailed / texted this
          contact + whether it landed (delivered / opened / clicked /
          bounced). Answers "what have we already tried?" without
          leaving the page. */}
      {messages.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
            <Mail size={12} /> Messages
          </h3>
          {messages.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 py-2 border-b border-un1t-border last:border-0">
              <div className="flex items-center gap-2 min-w-0">
                {m.channel === 'email'
                  ? <Mail size={13} className="text-un1t-subtle shrink-0" />
                  : <MessageSquare size={13} className="text-un1t-subtle shrink-0" />}
                <span className="text-sm truncate">{m.label}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-2 py-0.5 rounded-full text-[11px] border ${m.status.cls}`}>{m.status.text}</span>
                <span className="text-xs text-un1t-muted whitespace-nowrap">{relativeTime(m.at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* WhatsApp Conversations */}
      {(waConversations.length > 0 || contact.wa_phone) && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
            <MessageCircle size={12} /> WhatsApp
          </h3>
          {contact.wa_phone && (
            <p className="text-xs text-un1t-muted mb-2">{contact.wa_phone}</p>
          )}
          {waConversations.length === 0 && <p className="text-sm text-un1t-muted">No conversations</p>}
          {waConversations.map(conv => (
            <Link
              key={conv.id}
              href="/whatsapp/inbox"
              className="block py-2 border-b border-un1t-border last:border-0 hover:bg-un1t-border/20 -mx-1 px-1 rounded transition-colors"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm truncate flex-1">
                  {conv.last_message_direction === 'outbound' && <span className="text-un1t-subtle">You: </span>}
                  {conv.last_message_preview || 'No messages'}
                </p>
                {conv.unread_count > 0 && (
                  <span className="bg-green-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2">
                    {conv.unread_count}
                  </span>
                )}
              </div>
              <p className="text-xs text-un1t-muted mt-0.5">
                {conv.last_message_at ? new Date(conv.last_message_at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )

  const adminTab = (
    <div className="space-y-5">
      {/* Admin actions — edit / delete, app invite, password override.
          Each keeps its existing permission gate. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Actions</h3>
        <div className="flex flex-wrap items-center gap-3">
          {/* AUTH.1 — admin password override for members with a
              linked CRM auth account. Master/owner only. Contacts
              without a user_id link have no CRM login to reset, so
              the button is hidden rather than shown disabled. */}
          {contact.user_id && ['master', 'owner'].includes(user?.role) && (
            <MemberPasswordOverrideButton
              contactId={contact.id}
              contactLabel={contact.name || contact.email || 'this contact'}
            />
          )}
          <ContactEditDeleteActions
            contact={contact}
            canEdit={MANAGER_ROLES.includes(user?.role)}
            // Per the Nov 2026 widening: head_coach / manager / owner /
            // master can delete a contact (= MANAGER_ROLES). Same set
            // as canEdit since both are equally reversible-impact —
            // a wrongly-deleted contact is reconstructed from email
            // + history just like a wrongly-edited one.
            canDelete={MANAGER_ROLES.includes(user?.role)}
          />
          {/* Customer-facing app invite — owner/manager/master only.
              The button copy adapts based on whether the contact is
              already linked to an auth user (mig 110 contacts.user_id). */}
          {(user?.isMaster || ['owner', 'manager'].includes(user?.role)) && contact.email && (
            <InviteToAppButton
              contactId={contact.id}
              hasUserAccount={Boolean(contact.user_id)}
            />
          )}
          {/* NB: "Create in Glofox" (CreateInGlofoxButton) is NOT duplicated
              here — it already lives inside GlofoxProfileCard (Overview tab)
              for unlinked contacts. Kept in one place to honour
              "every component appears in exactly one tab". */}
        </div>
      </div>

      {/* HR devices: chest strap MAC registry. Member or staff
          register here; bridge auto-routes samples to bookings. */}
      <ContactDevicesCard
        contactId={contact.id}
        canEdit={user?.isMaster || ['owner', 'manager', 'head_coach'].includes(user?.role)}
      />

      {/* CONSENT.1 — operator toggles for marketing email / SMS /
          WhatsApp. Transactional sends stay on regardless. PATCH
          path is master/owner only; everyone else sees the panel
          read-only so they at least know the contact's status.
          CONSENT.2 — passes glofox_membership_status so the card
          can show the "Auto-unsubscribed (ClassPass policy)"
          banner when relevant. */}
      <ContactMarketingPreferencesCard
        contactId={contact.id}
        canEdit={user?.isMaster || ['owner'].includes(user?.role)}
        glofoxMembershipStatus={contact.glofox_membership_status}
      />

      {/* CONSENT.3 — full-width consent history table. Collapsed by
          default; lazy-loads on first expand so the contact page's
          initial render isn't paying for it. The append-only
          consent_log table is the audit source of truth — every
          opt_in / opt_out from any path (preference centre, admin
          panel, classpass auto-trigger, one-click unsubscribe)
          writes a row. */}
      <ContactConsentHistoryCard contactId={contact.id} />
    </div>
  )

  return (
    <div className="p-6 max-w-5xl">
      {/* Back link */}
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-5">
        <ArrowLeft size={16} /> Contacts
      </Link>

      {/* PERSON-LINK.1 — unified person header. Member photo (legacy)
          alongside the PersonHeader strip (name + stage pill + linked
          chip). The radar's at-risk signal rides in the actions slot.
          linkedCount drives the "N linked accounts" chip. */}
      <div className="flex items-start gap-4 mb-6">
        {/* GLOFOX-PROFILE — member photo (mig 196 glofox_image_url).
            Plain <img>: Glofox CDN URLs aren't whitelisted for
            next/image and adding a remote pattern per third-party
            host isn't worth it for one avatar. */}
        {contact.glofox_image_url && (
          <img
            src={contact.glofox_image_url}
            alt={contact.name || 'Member'}
            className="w-16 h-16 rounded-full object-cover border border-un1t-border shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <PersonHeader
            name={contact.name}
            stageSlug={contact.pipeline_stage_slug}
            linkedCount={person ? person.accounts.length : 1}
          >
            {/* CHURN-CONTACT.1 — the radar's at-risk signal, on the person. */}
            {risk && (
              <span title={risk.title} className={`px-3 py-1 rounded-full text-sm border ${risk.cls}`}>
                {risk.label}
              </span>
            )}
            {/* FUNNEL.4 — Message / Task / Sequence + the Cold toggle
                (mark not-interested / return to pipeline). */}
            <PersonActionBar
              contactId={contact.id}
              locationId={contact.location_id}
              actions={['message', 'task', 'sequence', 'cold']}
              isCold={contact.pipeline_stage_slug === 'cold_lead'}
            />
          </PersonHeader>
        </div>
      </div>

      <ContactDetailTabs
        tabs={[
          { id: 'overview', label: 'Overview', content: overviewTab },
          { id: 'activity', label: 'Activity', content: activityTab },
          // CONSULTATIONS SP1 — only when the caller holds the permission
          // (consultationsTab is null otherwise; ContactDetailTabs filters
          // out falsy entries).
          canConsultations ? { id: 'consultations', label: 'Consultations', content: consultationsTab } : null,
          { id: 'comms', label: 'Comms', content: commsTab },
          { id: 'admin', label: 'Admin', content: adminTab },
        ]}
      />
    </div>
  )
}

// PERSON-LINK.1 — compact metric tile for the Overview key-numbers grid.
// `tone='danger'` paints the value with the -700 ramp for arrears > 0
// (CLAUDE.md light-theme convention); default is the primary text token.
function MetricCard({ label, value, tone = 'default' }) {
  const valueCls = tone === 'danger' ? 'text-red-700' : 'text-un1t-text'
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{label}</p>
      <p className={`text-xl font-bold mt-1 ${valueCls}`}>{value}</p>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-un1t-subtle">{label}</span>
      <span className="font-medium">{value ?? '—'}</span>
    </div>
  )
}

// CONTACT-MSG.1 — collapse an email_sends row to its furthest-reached
// engagement state (the most informative thing to show at a glance).
function emailStatusPill(e) {
  if (e.complained_at) return { text: 'Spam report', cls: 'bg-red-50 text-red-700 border-red-200' }
  if (e.bounced_at) return { text: 'Bounced', cls: 'bg-red-50 text-red-700 border-red-200' }
  if (e.clicked_at) return { text: 'Clicked', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (e.opened_at) return { text: 'Opened', cls: 'bg-blue-50 text-blue-700 border-blue-200' }
  if (e.delivered_at) return { text: 'Delivered', cls: 'bg-un1t-bg text-un1t-subtle border-un1t-border' }
  return { text: 'Sent', cls: 'bg-un1t-bg text-un1t-subtle border-un1t-border' }
}

function smsStatusPill(s) {
  if (s.failed_at || s.undelivered_at) return { text: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200' }
  if (s.delivered_at) return { text: 'Delivered', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  return { text: 'Sent', cls: 'bg-un1t-bg text-un1t-subtle border-un1t-border' }
}

// Merge email + SMS sends into one "what we've sent + did it land"
// list, newest first, capped.
function buildMessageHistory(emails, smses) {
  const out = []
  for (const e of emails) {
    out.push({ id: `e-${e.id}`, channel: 'email', label: e.subject || 'Email', at: e.sent_at || e.created_at, status: emailStatusPill(e) })
  }
  for (const s of smses) {
    out.push({ id: `s-${s.id}`, channel: 'sms', label: s.sms_broadcasts?.name ? `SMS · ${s.sms_broadcasts.name}` : 'SMS broadcast', at: s.sent_at, status: smsStatusPill(s) })
  }
  return out
    .filter((m) => m.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 8)
}
