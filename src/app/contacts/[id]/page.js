import { createServerClient } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Mail, Phone, Calendar, MessageSquare, CheckSquare, Clock, BookOpen, ArrowRight, MessageCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import ContactActions from '@/components/ContactActions'
import StartWhatsAppButton from '@/components/StartWhatsAppButton'
import ContactRaceHistory from '@/components/ContactRaceHistory'
import ContactEditDeleteActions from '@/components/ContactEditDeleteActions'
import InviteToAppButton from '@/components/InviteToAppButton'
import MemberPasswordOverrideButton from '@/components/MemberPasswordOverrideButton'
import ContactDevicesCard from '@/components/ContactDevicesCard'
import ContactMarketingPreferencesCard from '@/components/ContactMarketingPreferencesCard'
import ContactConsentHistoryCard from '@/components/ContactConsentHistoryCard'
import CreateInGlofoxButton from '@/components/CreateInGlofoxButton'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${m} ${ampm}`
}

const activityIcons = {
  note: { bg: 'bg-blue-500/20', color: 'text-blue-400', label: 'Note' },
  call: { bg: 'bg-yellow-500/20', color: 'text-yellow-400', label: 'Call' },
  email: { bg: 'bg-purple-500/20', color: 'text-purple-400', label: 'Email' },
  meeting: { bg: 'bg-green-500/20', color: 'text-green-400', label: 'Meeting' },
  task: { bg: 'bg-orange-500/20', color: 'text-orange-400', label: 'Task' },
  booking: { bg: 'bg-indigo-500/20', color: 'text-indigo-400', label: 'Booking' },
  pipeline: { bg: 'bg-emerald-500/20', color: 'text-emerald-400', label: 'Pipeline' },
  whatsapp_sent: { bg: 'bg-green-500/20', color: 'text-green-400', label: 'WhatsApp Sent' },
  whatsapp_received: { bg: 'bg-green-500/20', color: 'text-green-300', label: 'WhatsApp Received' },
  // mig 059 — ad-hoc and (later) sequence/broadcast SMS sends.
  // No 'sms_received' counterpart yet; alpha sender IDs are
  // send-only in IE/UK/EU.
  sms_sent: { bg: 'bg-cyan-500/20', color: 'text-cyan-400', label: 'SMS Sent' },
}

export default async function ContactDetailPage({ params }) {
  const db = createServerClient()
  const user = await getCurrentUser()
  const { id } = params

  const [contactRes, dealsRes, notesRes, activitiesRes, bookingsRes, waConvRes] = await Promise.all([
    db.from('contacts').select('*').eq('id', id).single(),
    db.from('deals').select('*, pipeline_stages(name, color)').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('notes').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('activities').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('bookings').select('*, event_types(name, color)').eq('contact_id', id).order('booking_date', { ascending: true }),
    db.from('whatsapp_conversations').select('id, wa_phone, last_message_at, last_message_preview, last_message_direction, unread_count, status').eq('contact_id', id).order('last_message_at', { ascending: false }),
  ])

  if (!contactRes.data) notFound()

  const contact = contactRes.data
  const deals = dealsRes.data || []
  const notes = notesRes.data || []
  const activities = activitiesRes.data || []
  const bookings = bookingsRes.data || []
  const waConversations = waConvRes.data || []

  const today = new Date().toISOString().split('T')[0]
  const upcomingBookings = bookings.filter(b => b.booking_date >= today && b.status === 'confirmed')
  const pastBookings = bookings.filter(b => b.booking_date < today || b.status !== 'confirmed')

  // Build unified timeline from notes + activities, sorted by date
  const timeline = [
    ...notes.map(n => ({ type: 'note', activityType: 'note', date: n.created_at, ...n })),
    ...activities.map(a => ({ type: 'activity', activityType: a.type || 'task', date: a.created_at, ...a })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  // Keyed on pipeline_stage_slug (PIPELINE5 + CLASSIFY.2).
  const statusColors = {
    new_lead:          'bg-blue-500/20 text-blue-400 border-blue-500/30',
    active_trial:      'bg-green-500/20 text-green-400 border-green-500/30',
    hot_conversion:    'bg-amber-500/20 text-amber-400 border-amber-500/30',
    active_member:     'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    at_risk_member:    'bg-orange-500/20 text-orange-400 border-orange-500/30',
    classpass_active:  'bg-purple-500/20 text-purple-400 border-purple-500/30',
    lapsed:            'bg-red-500/20 text-red-400 border-red-500/30',
    dormant:           'bg-gray-500/20 text-gray-400 border-gray-500/30',
    dormant_classpass: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  }

  const bookingStatusColors = {
    confirmed: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-green-500/20 text-green-400',
    cancelled: 'bg-red-500/20 text-red-400',
    no_show: 'bg-yellow-500/20 text-yellow-400',
  }

  return (
    <div className="p-6 max-w-5xl">
      {/* Back link */}
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-5">
        <ArrowLeft size={16} /> Contacts
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{contact.name}</h2>
          <div className="flex items-center gap-4 mt-2 text-sm text-un1t-light">
            {contact.email && <span className="flex items-center gap-1.5"><Mail size={14} /> {contact.email}</span>}
            {contact.phone && <span className="flex items-center gap-1.5"><Phone size={14} /> {contact.phone}</span>}
            {contact.wa_phone && contact.wa_phone !== contact.phone && (
              <span className="flex items-center gap-1.5"><MessageCircle size={14} /> {contact.wa_phone}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
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
          <StartWhatsAppButton
            contactId={contact.id}
            contactPhone={contact.phone}
            waPhone={contact.wa_phone}
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
          <span className={`px-3 py-1 rounded-full text-sm border ${statusColors[contact.pipeline_stage_slug] || 'bg-un1t-gray text-un1t-light border-un1t-gray'}`}>
            {contact.pipeline_stage_slug?.replaceAll('_', ' ')}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Contact Info + Deals + Bookings */}
        <div className="col-span-1 space-y-5">
          {/* Info Card. GLOFOX2.9 — Glofox-specific fields (credits,
              glofox_member_id) moved to the dedicated Glofox Profile
              card below. This card now only carries CRM-native
              identifiers. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Details</h3>
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

          {/* Deals */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Deals</h3>
            {deals.length === 0 && <p className="text-sm text-un1t-mid">No deals</p>}
            {deals.map(deal => (
              <div key={deal.id} className="flex items-center justify-between py-2 border-b border-un1t-gray last:border-0">
                <span className="text-sm">{deal.title}</span>
                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: deal.pipeline_stages?.color + '30', color: deal.pipeline_stages?.color }}>
                  {deal.pipeline_stages?.name}
                </span>
              </div>
            ))}
          </div>

          {/* GLOFOX2.9 — Glofox bookings now live INSIDE the
              GlofoxProfileCard above, alongside the rest of the
              membership data. */}

          {/* WhatsApp Conversations */}
          {(waConversations.length > 0 || contact.wa_phone) && (
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3 flex items-center gap-1.5">
                <MessageCircle size={12} /> WhatsApp
              </h3>
              {contact.wa_phone && (
                <p className="text-xs text-un1t-mid mb-2">{contact.wa_phone}</p>
              )}
              {waConversations.length === 0 && <p className="text-sm text-un1t-mid">No conversations</p>}
              {waConversations.map(conv => (
                <Link
                  key={conv.id}
                  href="/whatsapp/inbox"
                  className="block py-2 border-b border-un1t-gray last:border-0 hover:bg-un1t-gray/20 -mx-1 px-1 rounded transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm truncate flex-1">
                      {conv.last_message_direction === 'outbound' && <span className="text-un1t-light">You: </span>}
                      {conv.last_message_preview || 'No messages'}
                    </p>
                    {conv.unread_count > 0 && (
                      <span className="bg-green-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2">
                        {conv.unread_count}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-un1t-mid mt-0.5">
                    {conv.last_message_at ? new Date(conv.last_message_at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  </p>
                </Link>
              ))}
            </div>
          )}

          {/* CRM-native event registrations — workshops, masterclasses,
              open days, races (the /events flow). Distinct from Glofox
              class bookings which appear in the Glofox Profile card
              above. Only render when there's something to show OR
              when the contact has any registrations history (avoids
              empty-state clutter for trial members). */}
          {(upcomingBookings.length > 0 || pastBookings.length > 0) && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Upcoming event registrations</h3>
            {upcomingBookings.length === 0 && <p className="text-sm text-un1t-mid">None</p>}
            {upcomingBookings.map(b => (
              <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-gray last:border-0">
                <div
                  className="w-1 h-8 rounded-full mt-0.5 shrink-0"
                  style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{b.event_types?.name || 'Event'}</p>
                  <p className="text-xs text-un1t-light mt-0.5">
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
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Races</h3>
            <ContactRaceHistory contactId={contact.id} />
          </div>

          {/* Past event registrations (CRM-native). */}
          {pastBookings.length > 0 && (
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Past event registrations</h3>
              {pastBookings.map(b => (
                <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-gray last:border-0 opacity-60">
                  <div
                    className="w-1 h-8 rounded-full mt-0.5 shrink-0"
                    style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{b.event_types?.name || 'Event'}</p>
                    <p className="text-xs text-un1t-light mt-0.5">
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
              Auto-logged events live on the timeline on the right. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Open tasks</h3>
            {activities.filter(a => a.kind === 'task' && !a.done).length === 0 && (
              <p className="text-sm text-un1t-mid">No open tasks</p>
            )}
            {activities.filter(a => a.kind === 'task' && !a.done).map(a => (
              <div key={a.id} className="flex items-start gap-2 py-2 border-b border-un1t-gray last:border-0">
                <CheckSquare size={14} className="text-un1t-mid mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm">{a.subject}</p>
                  {a.due_date && (
                    <p className="text-xs text-un1t-light flex items-center gap-1 mt-0.5">
                      <Clock size={10} /> {a.due_date} {a.due_time ? formatTime(a.due_time) : ''}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Timeline */}
        <div className="col-span-2">
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-un1t-gray">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Timeline</h3>
              <ContactActions
                contactId={contact.id}
                locationId={contact.location_id}
                canSms={hasPermission(user, 'sms')}
                hasPhone={!!contact.phone}
                smsBlocked={contact.sms_status && contact.sms_status !== 'active'}
              />
            </div>
            <div className="divide-y divide-un1t-gray">
              {timeline.length === 0 && (
                <p className="text-sm text-un1t-mid text-center py-12">No activity yet</p>
              )}
              {timeline.map((item, i) => {
                const iconConfig = activityIcons[item.activityType] || activityIcons.task
                const IconComponent = item.activityType === 'note' ? MessageSquare
                  : item.activityType === 'booking' ? BookOpen
                  : item.activityType === 'pipeline' ? ArrowRight
                  : item.activityType === 'email' ? Mail
                  : item.activityType === 'meeting' ? Calendar
                  : item.activityType === 'whatsapp_sent' || item.activityType === 'whatsapp_received' ? MessageCircle
                  : CheckSquare

                return (
                  <div key={item.id || i} className="p-4 flex gap-3">
                    <div className={`mt-1 shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${iconConfig.bg}`}>
                      <IconComponent size={14} className={iconConfig.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-un1t-light uppercase">
                            {iconConfig.label}
                          </span>
                          {item.type === 'activity' && item.activityType !== 'note' && (
                            <span className="text-sm font-medium">{item.subject}</span>
                          )}
                        </div>
                        <span className="text-xs text-un1t-mid">
                          {new Date(item.date).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm mt-1 whitespace-pre-wrap text-un1t-light">
                        {item.content || item.note || item.description || ''}
                      </p>
                      {item.type === 'activity' && item.done && item.activityType !== 'pipeline' && item.activityType !== 'booking' && (
                        <span className="text-xs text-green-400 mt-1 inline-block">Completed</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* CONSENT.3 — full-width consent history table at the bottom
          of the page. Collapsed by default; lazy-loads on first
          expand so the contact page's initial render isn't paying
          for it. The append-only consent_log table is the audit
          source of truth — every opt_in / opt_out from any path
          (preference centre, admin panel, classpass auto-trigger,
          one-click unsubscribe) writes a row. */}
      <div className="mt-6">
        <ContactConsentHistoryCard contactId={contact.id} />
      </div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-un1t-light">{label}</span>
      <span className="font-medium">{value ?? '—'}</span>
    </div>
  )
}

// GLOFOX2.9 — consolidated Glofox Profile card. Single rich panel
// absorbing every Glofox-synced field — status, credits, LTV,
// tenure, engagement, last payment, upcoming + recent bookings,
// DOB, Glofox ID. Always rendered (every CRM contact should also
// exist in Glofox under the bidirectional-sync model — when not
// yet linked, shows an empty state with a hint instead of being
// hidden).
//
// Operator gets a one-glance view of the member's whole Glofox
// relationship without scrolling between cards.

const GLOFOX_STATUS_META = {
  cold:           { label: 'Cold',                  cls: 'bg-gray-500/20    text-gray-300    border-gray-500/30' },
  tour:           { label: 'Tour booked',           cls: 'bg-blue-500/20    text-blue-300    border-blue-500/30' },
  no_sale_tour:   { label: 'No sale (tour)',        cls: 'bg-amber-500/20   text-amber-300   border-amber-500/30' },
  trial:          { label: 'Trial',                 cls: 'bg-blue-500/20    text-blue-300    border-blue-500/30' },
  no_sale_trial:  { label: 'No sale (trial)',       cls: 'bg-amber-500/20   text-amber-300   border-amber-500/30' },
  member:         { label: 'Member',                cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  credit_member:  { label: 'Credit Member',         cls: 'bg-teal-500/20    text-teal-300    border-teal-500/30' },
  classpass_payg: { label: 'ClassPass PAYG',        cls: 'bg-purple-500/20  text-purple-300  border-purple-500/30' },
  ex_member:      { label: 'Ex-member',             cls: 'bg-red-500/20     text-red-300     border-red-500/30' },
  lead:           { label: 'Lead',                  cls: 'bg-gray-500/20    text-gray-300    border-gray-500/30' },
}

function formatTenure(joinedAtIso) {
  if (!joinedAtIso) return null
  const ms = Date.now() - new Date(joinedAtIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const days = Math.floor(ms / 86_400_000)
  if (days < 30) return `Joined ${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `Joined ${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  const remMonths = months % 12
  return `Joined ${years}y${remMonths ? ` ${remMonths}mo` : ''} ago`
}

function relativeTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const abs = Math.abs(ms)
  const future = ms < 0
  const days = Math.floor(abs / 86_400_000)
  if (days < 1) {
    const hours = Math.floor(abs / 3_600_000)
    if (hours < 1) return future ? 'in a moment' : 'just now'
    return future ? `in ${hours}h` : `${hours}h ago`
  }
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30.44)
  return future ? `in ${months}mo` : `${months}mo ago`
}

function formatMoney(cents, currency) {
  if (!Number.isFinite(cents)) return null
  const amount = cents / 100
  // Currency code → symbol map covers the common ones; falls back
  // to the code itself prefixed if unknown.
  const SYM = { EUR: '€', GBP: '£', USD: '$' }
  const sym = SYM[currency] || (currency ? `${currency} ` : '€')
  return sym + amount.toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

function GlofoxProfileCard({ contact }) {
  const linked = Boolean(contact.glofox_member_id)
  const statusMeta = GLOFOX_STATUS_META[contact.glofox_membership_status] || null
  const tenure = formatTenure(contact.joined_at)
  const lastAttended = relativeTime(contact.last_attended_at)
  const lastPayment = relativeTime(contact.last_payment_at)
  const ltv = Number.isFinite(contact.lifetime_value_cents) && contact.lifetime_value_cents > 0
    ? formatMoney(contact.lifetime_value_cents, contact.lifetime_currency)
    : null
  const credits = contact.trial_credits_remaining

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Glofox membership</h3>
        {linked && (
          <span className="text-[10px] text-un1t-mid">
            Synced {contact.glofox_synced_at ? relativeTime(contact.glofox_synced_at) : 'never'}
          </span>
        )}
      </div>

      {!linked && (
        <div className="space-y-2">
          <div className="text-sm text-un1t-mid py-2 text-center">
            Not yet linked to Glofox.
            <p className="text-xs mt-1">Push this contact to Glofox: we&apos;ll search by email first, and create + attach the trial if they don&apos;t exist yet.</p>
          </div>
          <CreateInGlofoxButton contact={contact} />
        </div>
      )}

      {linked && (
        <>
          {/* Status row — badge + headline numbers */}
          <div className="flex items-center gap-2 flex-wrap">
            {statusMeta ? (
              <span className={`text-xs px-2 py-0.5 rounded-full border ${statusMeta.cls}`}>
                {statusMeta.label}
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-300 border border-gray-500/30">
                {contact.glofox_membership_status || 'Unknown'}
              </span>
            )}
            {credits != null && (
              <span className="text-xs text-un1t-light">· {credits} credit{credits === 1 ? '' : 's'}</span>
            )}
            {ltv && (
              <span className="text-xs text-un1t-light">· {ltv} LTV</span>
            )}
          </div>

          {/* Tenure + engagement strip */}
          <div className="text-xs text-un1t-light space-y-1">
            {tenure && <p>{tenure}</p>}
            {lastAttended && <p>Last attended {lastAttended}</p>}
            {Number(contact.total_attended_30d) > 0 && (
              <p>
                {contact.total_attended_30d} attended in last 30d
                {Number(contact.total_noshow_30d) > 0 && (
                  <span className="text-amber-400/80"> · {contact.total_noshow_30d} no-show{contact.total_noshow_30d === 1 ? '' : 's'}</span>
                )}
              </p>
            )}
            {lastPayment && contact.lifetime_transaction_count > 0 && (
              <p>Last paid {lastPayment} · {contact.lifetime_transaction_count} payment{contact.lifetime_transaction_count === 1 ? '' : 's'} total</p>
            )}
          </div>

          {/* Bookings sub-section */}
          {Array.isArray(contact.recent_bookings) && contact.recent_bookings.length > 0 && (
            <BookingsSubsection bookings={contact.recent_bookings} />
          )}

          {/* Reference info — small text at the bottom */}
          <div className="pt-2 border-t border-un1t-gray text-[11px] text-un1t-mid space-y-0.5">
            {contact.dob && <p>DOB: {contact.dob}</p>}
            <p className="font-mono truncate">ID: {contact.glofox_member_id}</p>
          </div>
        </>
      )}
    </div>
  )
}

function BookingsSubsection({ bookings }) {
  const nowSec = Math.floor(Date.now() / 1000)
  const upcoming = bookings.filter(b => Number(b.time_start) > nowSec)
                           .sort((a, b) => Number(a.time_start) - Number(b.time_start))
  const past = bookings.filter(b => Number(b.time_start) <= nowSec)
                       .sort((a, b) => Number(b.time_start) - Number(a.time_start))
  if (upcoming.length === 0 && past.length === 0) return null
  return (
    <div className="pt-2 border-t border-un1t-gray space-y-3">
      {upcoming.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-un1t-mid mb-1.5">Upcoming</p>
          <div className="space-y-1.5">
            {upcoming.map(b => <BookingRow key={b.glofox_id || b.time_start} b={b} when="future" />)}
          </div>
        </div>
      )}
      {past.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-un1t-mid mb-1.5">Recent</p>
          <div className="space-y-1.5">
            {past.map(b => <BookingRow key={b.glofox_id || b.time_start} b={b} when="past" />)}
          </div>
        </div>
      )}
    </div>
  )
}

function BookingRow({ b, when }) {
  const status = String(b.status || '').toUpperCase()
  const isCancelled = status === 'CANCELED' || status === 'CANCELLED'
  let badge = null
  if (isCancelled) {
    badge = { label: 'Cancelled', cls: 'bg-red-500/20 text-red-300' }
  } else if (status === 'WAITING') {
    badge = { label: 'Waitlist', cls: 'bg-purple-500/20 text-purple-300' }
  } else if (when === 'past' && status === 'BOOKED') {
    badge = b.attended === true
      ? { label: 'Attended', cls: 'bg-green-500/20 text-green-300' }
      : { label: 'No-show',  cls: 'bg-amber-500/20 text-amber-300' }
  } else if (when === 'future' && status === 'BOOKED') {
    badge = { label: 'Booked', cls: 'bg-blue-500/20 text-blue-300' }
  }
  const ts = Number(b.time_start) ? new Date(Number(b.time_start) * 1000) : null
  const dateStr = ts
    ? ts.toLocaleString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <div className="flex items-start justify-between text-sm gap-2">
      <div className="min-w-0 flex-1">
        <p className={`font-medium truncate ${isCancelled ? 'line-through text-un1t-mid' : ''}`}>
          {b.event_name || b.model_name || '—'}
        </p>
        <p className="text-xs text-un1t-mid">{dateStr}</p>
      </div>
      {badge && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${badge.cls}`}>
          {badge.label}
        </span>
      )}
    </div>
  )
}
