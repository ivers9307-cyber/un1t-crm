'use client'

// DRAWER.3 — the contact timeline, extracted verbatim from
// /contacts/[id]/page.js so the pipeline contact drawer can render the
// same history. Two variants, same as the page had:
//   - grouped person (person.accounts.length > 1): the cross-account
//     aggregate timeline, tagged by source account
//   - single contact: the notes+activities merge (mergeTimeline output)
// Filter pills (All / Classes / Messages / Notes / System) are opt-in
// via showFilters and only apply to the single-contact variant — the
// grouped aggregate has a different item shape.

import { useState } from 'react'
import {
  Mail, Calendar, MessageSquare, CheckSquare, Clock, BookOpen, ArrowRight, MessageCircle,
} from 'lucide-react'
import { timelineFilterGroup } from '@/lib/contact-view'

const activityIcons = {
  note: { bg: 'bg-blue-500/20', color: 'text-blue-700', label: 'Note' },
  call: { bg: 'bg-yellow-500/20', color: 'text-yellow-700', label: 'Call' },
  email: { bg: 'bg-purple-500/20', color: 'text-purple-700', label: 'Email' },
  meeting: { bg: 'bg-green-500/20', color: 'text-green-700', label: 'Meeting' },
  task: { bg: 'bg-orange-500/20', color: 'text-orange-700', label: 'Task' },
  booking: { bg: 'bg-indigo-500/20', color: 'text-indigo-700', label: 'Booking' },
  pipeline: { bg: 'bg-emerald-500/20', color: 'text-emerald-700', label: 'Pipeline' },
  whatsapp_sent: { bg: 'bg-green-500/20', color: 'text-green-700', label: 'WhatsApp Sent' },
  whatsapp_received: { bg: 'bg-green-500/20', color: 'text-green-700', label: 'WhatsApp Received' },
  sms_sent: { bg: 'bg-cyan-500/20', color: 'text-cyan-700', label: 'SMS Sent' },
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'classes', label: 'Classes' },
  { id: 'messages', label: 'Messages' },
  { id: 'notes', label: 'Notes' },
  { id: 'system', label: 'System' },
]

export function TimelineFilterPills({ filter, onChange }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onChange(f.id)}
          className={`text-[11px] px-2 py-0.5 rounded font-medium ${
            filter === f.id
              ? 'bg-un1t-text text-un1t-bg'
              : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

export default function ContactTimeline({
  timeline = [],
  person = null,
  showFilters = false,
  emptyText = 'No activity yet',
}) {
  const [filter, setFilter] = useState('all')
  const grouped = Boolean(person && person.accounts.length > 1)

  if (grouped) {
    return (
      <div className="divide-y divide-un1t-border">
        {person.timeline.length === 0 && (
          <p className="text-sm text-un1t-muted text-center py-12">{emptyText}</p>
        )}
        {person.timeline.map((item, i) => {
          const acct = person.accounts.find((a) => a.contactId === item.sourceContactId)
          return (
            <div key={`${item.sourceContactId}-${i}`} className="p-4 flex gap-3">
              <div className="mt-1 shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-un1t-text/[0.06]">
                <Clock size={14} className="text-un1t-subtle" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-un1t-subtle uppercase">
                      {item.type || 'Event'}
                    </span>
                    {/* GLOFOX-NOTES — provenance chip on the grouped
                        timeline too (matches the single-account view). */}
                    {item.source === 'glofox' && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-500/10 text-slate-700">
                        Glofox
                      </span>
                    )}
                    {/* Tag the source account when the group has more
                        than one, so a merged timeline stays legible. */}
                    {acct?.name && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-un1t-text/[0.06] text-un1t-subtle truncate">
                        {acct.name}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-un1t-muted whitespace-nowrap">
                    {item.createdAt ? new Date(item.createdAt).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
                {(item.body || item.title) && (
                  <p className="text-sm mt-1 whitespace-pre-wrap text-un1t-subtle">{item.body || item.title}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const items = filter === 'all'
    ? timeline
    : timeline.filter((i) => timelineFilterGroup(i) === filter)

  return (
    <div>
      {showFilters && (
        <div className="px-4 pt-3">
          <TimelineFilterPills filter={filter} onChange={setFilter} />
        </div>
      )}
      <div className="divide-y divide-un1t-border">
        {items.length === 0 && (
          <p className="text-sm text-un1t-muted text-center py-12">{emptyText}</p>
        )}
        {items.map((item, i) => {
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
                    <span className="text-xs font-medium text-un1t-subtle uppercase">
                      {iconConfig.label}
                    </span>
                    {item.type === 'activity' && item.activityType !== 'note' && (
                      <span className="text-sm font-medium">{item.subject}</span>
                    )}
                    {/* GLOFOX-NOTES.7 — provenance chip. Glofox-synced
                        activities already appear in this unified timeline;
                        this just makes the source obvious so staff don't
                        mistake a front-desk Glofox note for a CRM one. */}
                    {item.type === 'activity' && item.source === 'glofox' && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-500/10 text-slate-700">
                        Glofox
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-un1t-muted">
                    {new Date(item.date).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-sm mt-1 whitespace-pre-wrap text-un1t-subtle">
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
  )
}
