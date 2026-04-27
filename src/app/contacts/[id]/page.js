import { createServerClient } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Mail, Phone, Tag, Calendar, MessageSquare, CheckSquare, Clock } from 'lucide-react'
import ContactActions from '@/components/ContactActions'

export const dynamic = 'force-dynamic'

export default async function ContactDetailPage({ params }) {
  const db = createServerClient()
  const { id } = params

  const [contactRes, dealsRes, notesRes, activitiesRes] = await Promise.all([
    db.from('contacts').select('*').eq('id', id).single(),
    db.from('deals').select('*, pipeline_stages(name, color)').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('notes').select('*').eq('contact_id', id).order('created_at', { ascending: false }),
    db.from('activities').select('*').eq('contact_id', id).order('due_date', { ascending: true }),
  ])

  if (!contactRes.data) notFound()

  const contact = contactRes.data
  const deals = dealsRes.data || []
  const notes = notesRes.data || []
  const activities = activitiesRes.data || []

  // Build timeline from notes + activities, sorted by date
  const timeline = [
    ...notes.map(n => ({ type: 'note', date: n.created_at, ...n })),
    ...activities.map(a => ({ type: 'activity', date: a.created_at, ...a })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  const statusColors = {
    active_trial: 'bg-green-500/20 text-green-400 border-green-500/30',
    member: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    cold: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    lost_member: 'bg-red-500/20 text-red-400 border-red-500/30',
    returning: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  }

  return (
    <div className="p-6 max-w-5xl">
      {/* Back link */}
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-white mb-5">
        <ArrowLeft size={16} /> Contacts
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{contact.name}</h2>
          <div className="flex items-center gap-4 mt-2 text-sm text-un1t-light">
            {contact.email && <span className="flex items-center gap-1.5"><Mail size={14} /> {contact.email}</span>}
            {contact.phone && <span className="flex items-center gap-1.5"><Phone size={14} /> {contact.phone}</span>}
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-sm border ${statusColors[contact.lead_status] || 'bg-un1t-gray text-un1t-light border-un1t-gray'}`}>
          {contact.lead_status?.replace('_', ' ')}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Contact Info + Deals */}
        <div className="col-span-1 space-y-5">
          {/* Info Card */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Details</h3>
            <InfoRow label="Source" value={contact.lead_source} />
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

          {/* Upcoming Activities */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Activities</h3>
            {activities.length === 0 && <p className="text-sm text-un1t-mid">No activities</p>}
            {activities.filter(a => !a.done).map(a => (
              <div key={a.id} className="flex items-start gap-2 py-2 border-b border-un1t-gray last:border-0">
                <CheckSquare size={14} className="text-un1t-mid mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm">{a.subject}</p>
                  {a.due_date && (
                    <p className="text-xs text-un1t-light flex items-center gap-1 mt-0.5">
                      <Clock size={10} /> {a.due_date} {a.due_time || ''}
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
              <ContactActions contactId={contact.id} />
            </div>
            <div className="divide-y divide-un1t-gray">
              {timeline.length === 0 && (
                <p className="text-sm text-un1t-mid text-center py-12">No activity yet</p>
              )}
              {timeline.map((item, i) => (
                <div key={item.id || i} className="p-4 flex gap-3">
                  <div className={`mt-1 shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                    item.type === 'note' ? 'bg-blue-500/20' : 'bg-yellow-500/20'
                  }`}>
                    {item.type === 'note'
                      ? <MessageSquare size={14} className="text-blue-400" />
                      : <CheckSquare size={14} className="text-yellow-400" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-un1t-light uppercase">
                        {item.type === 'note' ? 'Note' : item.subject}
                      </span>
                      <span className="text-xs text-un1t-mid">
                        {new Date(item.date).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-sm mt-1 whitespace-pre-wrap">{item.content || item.note || ''}</p>
                    {item.type === 'activity' && item.done && (
                      <span className="text-xs text-green-400 mt-1 inline-block">Completed</span>
                    )}
                  </div>
                </div>
              ))}
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
