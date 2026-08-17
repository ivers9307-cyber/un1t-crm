import { createServerClient } from '@/lib/supabase'
import { matchCatalogToPlan } from '@/lib/glofox-catalog'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Mail, MessageSquare, MessageCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { dublinTodayStr } from '@/lib/dublin-time'
import { canViewContact } from '@/lib/contact-crossovers'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import { classifyContact, scoreMember } from '@/lib/churn-radar'
import { loadContactArrears } from '@/lib/churn-radar-data'
import { loadContactJourney } from '@/lib/onboarding-journey-data'
import { nextBookedClass } from '@/lib/pipeline-classifier'
import ContactActions from '@/components/ContactActions'
import ContactComposer from '@/components/ContactComposer'
import ContactBookingCard from '@/components/ContactBookingCard'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'
import StartWhatsAppButton from '@/components/StartWhatsAppButton'
import ContactConsentHistoryCard from '@/components/ContactConsentHistoryCard'
// PERSON-LINK.1 — unified person identity view (mig 270 tables).
import { getPersonGroup } from '@/lib/person-links'
import { aggregatePerson } from '@/lib/person-aggregate'
// CC.2 — command-centre sections (shared with the pipeline drawer where
// noted on each component).
import ContactHeaderBand from '@/components/contact/ContactHeaderBand'
import ContactWhoRail from '@/components/contact/ContactWhoRail'
import ContactNextRail from '@/components/contact/ContactNextRail'
import ContactTimeline from '@/components/contact/ContactTimeline'
import { PastEventsCard } from '@/components/contact/EventRegistrationsCards'
import { relativeTime } from '@/components/contact/format'
import { mergeTimeline, deriveNeedsAttention } from '@/lib/contact-view'
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

  const [dealsRes, notesRes, activitiesRes, bookingsRes, waConvRes, eventTypesRes, contactArrears] = await Promise.all([
    db.from('deals').select('*, pipeline_stages(name, color)').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('notes').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('activities').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('bookings').select('*, event_types(name, color)').eq('contact_id', id).order('booking_date', { ascending: true }),
    db.from('whatsapp_conversations').select('id, wa_phone, last_message_at, last_message_preview, last_message_direction, unread_count, status, window_expires_at').eq('contact_id', id).order('last_message_at', { ascending: false }),
    // BOOK-ON-PROFILE.1 — bookable consultation event types for this
    // studio, so the profile's Book card matches the inbox Book tab.
    db.from('event_types').select('id, name, slug, duration_minutes, availability, active').eq('location_id', contact.location_id).eq('active', true).order('name'),
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
  const bookableEventTypes = eventTypesRes?.data || []

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

  // CC.2 — forward-looking derivations for the header chips + next
  // rail. next_class_at is derived (not a contacts column) — the same
  // helper the pipeline page uses server-side.
  const openTasks = activities.filter(a => a.kind === 'task' && !a.done)
  const nextClassAt = nextBookedClass(contact.recent_bookings)
  const attention = deriveNeedsAttention({
    contact: { ...contact, next_class_at: nextClassAt },
    arrearsCents: metricArrearsCents || 0,
    openTasks,
    todayStr: today,
  })

  // ── CC.2 — command-centre layout (tabs removed) ─────────────────────────
  // One screen, three columns: who they are / what happened / what
  // happens next. Consultations (permission-gated) + the consent-history
  // audit table render full-width below the grid.

  return (
    <div className="p-6">
      {/* Back link */}
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-5">
        <ArrowLeft size={16} /> Contacts
      </Link>

      <ContactHeaderBand
        contact={contact}
        person={person}
        risk={risk}
        journey={journey}
        attention={attention}
        nextClassAt={nextClassAt}
        canToggleExempt={MANAGER_ROLES.includes(user?.role)}
        metrics={{
          ltvCents,
          arrearsCents: metricArrearsCents,
          attended: metricAttended,
          deals: metricDeals,
          currency: contact.lifetime_currency,
        }}
      />

      <div className="grid gap-5 items-start xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        {/* Who they are — stacks under the working column on small screens. */}
        <div className="space-y-5 order-3 xl:order-1 min-w-0">
          <ContactWhoRail
            contact={contact}
            person={person}
            identityEmails={identityEmails}
            identityPhones={identityPhones}
            canEditPrefs={user?.isMaster || ['owner'].includes(user?.role)}
          />
        </div>

        {/* What happened — composer on top of the unified timeline, so
            reading history and acting on it live in one column. */}
        <div className="space-y-5 order-1 xl:order-2 min-w-0">
          {/* #message anchor — PersonActionBar's "Message" action
              deep-links here (/contacts/[id]#message). */}
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
              emailBlocked={['bounced', 'complained'].includes(contact.email_status)}
              whatsappWindowOpen={whatsappWindowOpen}
              whatsappWindowExpiresAt={latestWaConversation?.window_expires_at || null}
              templates={composerTemplates}
            />
          </div>

          {/* Timeline. PERSON-LINK.1 — grouped contacts render the
              cross-account aggregate, tagged by source account. */}
          <div className="bg-un1t-surface border border-un1t-border rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-un1t-border">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Timeline</h3>
              <ContactActions
                contactId={contact.id}
                locationId={contact.location_id}
              />
            </div>
            <ContactTimeline timeline={timeline} person={person} showFilters />
          </div>

          {/* CONTACT-MSG.1 — Messages: what we've emailed / texted this
              contact + whether it landed. */}
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
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-1.5">
                  <MessageCircle size={12} /> WhatsApp
                </h3>
                <StartWhatsAppButton
                  contactId={contact.id}
                  contactPhone={contact.phone}
                  waPhone={contact.wa_phone}
                />
              </div>
              {contact.wa_phone && (
                <p className="text-xs text-un1t-muted mb-2">{contact.wa_phone}</p>
              )}
              {waConversations.length === 0 && <p className="text-sm text-un1t-muted">No conversations</p>}
              {waConversations.map(conv => (
                <Link
                  key={conv.id}
                  href="/communications/inbox"
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

          {/* Past event registrations (CRM-native). */}
          <PastEventsCard bookings={pastBookings} />
        </div>

        {/* What happens next. */}
        <div className="space-y-5 order-2 xl:order-3 min-w-0">
          <ContactNextRail
            contact={contact}
            attention={attention}
            openTasks={openTasks}
            sequences={activeSequences}
            upcomingBookings={upcomingBookings}
            deals={deals}
            admin={{
              canPasswordOverride: Boolean(contact.user_id) && ['master', 'owner'].includes(user?.role),
              canEditDelete: MANAGER_ROLES.includes(user?.role),
              canInvite: (user?.isMaster || ['owner', 'manager'].includes(user?.role)) && Boolean(contact.email),
              hasUserAccount: Boolean(contact.user_id),
              canEditDevices: user?.isMaster || ['owner', 'manager', 'head_coach'].includes(user?.role),
              // REPSET-P5 — admin contact-linking tool: master/owner ONLY
              // (staff never self-link their member contact; the route
              // re-enforces this server-side).
              canLinkAccount: user?.isMaster || ['master', 'owner'].includes(user?.role),
            }}
          />

          {/* BOOK-ON-PROFILE.1 — book this contact into a consultation or
              Glofox class, same engine as the inbox Book tab. */}
          <ContactBookingCard
            contactId={contact.id}
            locationId={contact.location_id}
            glofoxMemberId={contact.glofox_member_id || null}
            eventTypes={bookableEventTypes}
            waConversationId={latestWaConversation?.id || null}
            waWindowOpen={whatsappWindowOpen}
          />
        </div>
      </div>

      {/* CONSULTATIONS SP1 — full-width section (permission-gated). */}
      {canConsultations && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-4">Consultations</h2>
          {consultationsTab}
        </section>
      )}

      {/* CONSENT.3 — full-width consent history table (collapsed +
          lazy-loading, as before). */}
      <div className="mt-8">
        <ContactConsentHistoryCard contactId={contact.id} />
      </div>
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
