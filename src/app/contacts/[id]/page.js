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

  const statusColors = {
    active_trial: 'bg-green-500/20 text-green-400 border-green-500/30',
    member: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    cold: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    lost_member: 'bg-red-500/20 text-red-400 border-red-500/30',
    returning: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
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
          <span className={`px-3 py-1 rounded-full text-sm border ${statusColors[contact.lead_status] || 'bg-un1t-gray text-un1t-light border-un1t-gray'}`}>
            {contact.lead_status?.replace('_', ' ')}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Contact Info + Deals + Bookings */}
        <div className="col-span-1 space-y-5">
          {/* Info Card */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Details</h3>
            <InfoRow label="Source" value={contact.lead_source || contact.source} />
            <InfoRow label="Credits" value={contact.trial_credits_remaining} />
            <InfoRow label="Glofox ID" value={contact.glofox_member_id || '—'} />
            <InfoRow label="Label" value={contact.label || '—'} />
            <InfoRow label="Created" value={new Date(contact.created_at).toLocaleDateString('en-IE')} />
          </div>

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

          {/* Upcoming Bookings */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Upcoming Bookings</h3>
            {upcomingBookings.length === 0 && <p className="text-sm text-un1t-mid">No upcoming bookings</p>}
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

          {/* Race history (mig 086). Surfaces every race this contact
              has competed in — captain or member — with team, wave,
              and finish time. Always rendered; the component shows
              a "no races yet" message when empty. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Races</h3>
            <ContactRaceHistory contactId={contact.id} />
          </div>

          {/* Past Bookings */}
          {pastBookings.length > 0 && (
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Past Bookings</h3>
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
