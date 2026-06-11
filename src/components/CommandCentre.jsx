'use client'

// UIX-P2 — the unified inbox's contact command centre (right pane).
// Manage the person behind the thread without leaving the page:
//   Profile  — stage, tags, Glofox status, marketing consent toggles
//              (the existing ContactMarketingPreferencesCard — same
//              consent_log semantics as the STOP/START keywords),
//              quick actions (enrol in sequence, open full record).
//   Activity — compact timeline: activities + consent audit lines.
//   Book     — placeholder until UIX-P3 (Glofox probe results pending).

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  User, ListTodo, CalendarPlus, ExternalLink, Send, ShieldCheck,
  CircleDot, RefreshCw,
} from 'lucide-react'
import ContactMarketingPreferencesCard from '@/components/ContactMarketingPreferencesCard'
import SequencePicker from '@/components/SequencePicker'

function prettyStage(slug) {
  if (!slug) return null
  return slug.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
}

const TABS = [
  ['profile', 'Profile'],
  ['activity', 'Activity'],
  ['book', 'Book'],
]

export default function CommandCentre({ contactId, locationId, canEditConsent }) {
  const [tab, setTab] = useState('profile')
  const [contact, setContact] = useState(null)
  const [activities, setActivities] = useState([])
  const [consentLog, setConsentLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [showSequencePicker, setShowSequencePicker] = useState(false)

  const load = useCallback(async () => {
    if (!contactId) return
    setLoading(true)
    const [bundle, log] = await Promise.all([
      fetch(`/api/contacts/${contactId}/command-centre`).then(r => r.json()).then(d => d, () => null),
      fetch(`/api/contacts/${contactId}/consent-log`).then(r => r.json()).then(d => d, () => null),
    ])
    if (bundle?.success) {
      setContact(bundle.contact)
      setActivities(bundle.activities || [])
    }
    if (log?.success) setConsentLog(log.rows || [])
    setLoading(false)
  }, [contactId])

  useEffect(() => {
    setContact(null)
    setActivities([])
    setConsentLog([])
    setShowSequencePicker(false)
    load()
  }, [load])

  if (!contactId) return null

  const stage = prettyStage(contact?.pipeline_stage_slug)
  const tags = Array.isArray(contact?.tags) ? contact.tags : []
  const optedOut = contact?.wa_status === 'opted_out'

  // Activity tab: merge the activities timeline with consent audit
  // lines into one stream, newest first.
  const timeline = [
    ...activities.map(a => ({
      key: `a-${a.id}`,
      at: a.created_at,
      icon: <ListTodo size={12} className="text-un1t-subtle shrink-0" />,
      label: a.title || a.subject || a.description || a.type || 'Activity',
      meta: a.kind || a.type || null,
    })),
    ...consentLog.map(c => ({
      key: `c-${c.id}`,
      at: c.created_at,
      icon: <ShieldCheck size={12} className="text-amber-600 shrink-0" />,
      label: `${c.channel || 'consent'} ${c.action || ''}`.trim(),
      meta: c.source || null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-un1t-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <User size={16} className="text-un1t-subtle shrink-0" />
            <p className="font-semibold text-sm truncate">
              {contact?.name || contact?.first_name || 'Contact'}
            </p>
          </div>
          <button onClick={load} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh contact">
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {stage && (
            <span className="text-[10px] font-semibold bg-blue-500/10 text-blue-700 px-2 py-0.5 rounded-full">
              {stage}
            </span>
          )}
          {contact?.glofox_membership_status && (
            <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full">
              Glofox: {contact.glofox_membership_status}
            </span>
          )}
          {optedOut && (
            <span className="text-[10px] font-semibold bg-red-500/10 text-red-700 px-2 py-0.5 rounded-full">
              WA unsubscribed
            </span>
          )}
          {tags.slice(0, 4).map(t => (
            <span key={t} className="text-[10px] bg-un1t-border/60 text-un1t-subtle px-2 py-0.5 rounded-full">
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-2 border-b border-un1t-border">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => key !== 'book' && setTab(key)}
            disabled={key === 'book'}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              tab === key
                ? 'bg-un1t-text text-un1t-black border-transparent'
                : key === 'book'
                  ? 'border-un1t-border text-un1t-muted cursor-not-allowed'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {label}
            {key === 'book' && <span className="ml-1 text-[9px]">soon</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && !contact && (
          <p className="text-xs text-un1t-subtle text-center py-6">Loading…</p>
        )}

        {tab === 'profile' && contact && (
          <>
            {/* Quick actions */}
            <div className="relative space-y-1.5">
              <Link
                href={`/contacts/${contactId}`}
                className="flex items-center gap-2 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded-lg px-3 py-2 transition-colors"
              >
                <ExternalLink size={12} />
                Open full record
              </Link>
              <button
                onClick={() => setShowSequencePicker(v => !v)}
                className="w-full flex items-center gap-2 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded-lg px-3 py-2 transition-colors"
              >
                <Send size={12} />
                Enrol in sequence
              </button>
              {showSequencePicker && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1">
                  <SequencePicker
                    contactIds={[contactId]}
                    locationId={locationId}
                    variant="popover"
                    onClose={() => setShowSequencePicker(false)}
                    onSuccess={() => { setShowSequencePicker(false); load() }}
                  />
                </div>
              )}
            </div>

            {/* Marketing consent — the existing card, same consent_log
                semantics as the STOP/START keyword system. */}
            <ContactMarketingPreferencesCard
              contactId={contactId}
              canEdit={canEditConsent}
              glofoxMembershipStatus={contact?.glofox_membership_status}
            />
          </>
        )}

        {tab === 'activity' && (
          timeline.length === 0 ? (
            <p className="text-xs text-un1t-subtle text-center py-6">No activity yet.</p>
          ) : (
            <div className="space-y-2">
              {timeline.map(item => (
                <div key={item.key} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5">{item.icon || <CircleDot size={12} className="text-un1t-muted" />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-un1t-text truncate">{item.label}</p>
                    <p className="text-[10px] text-un1t-muted">
                      {timeAgo(item.at)}{item.meta ? ` · ${item.meta}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'book' && (
          <div className="text-center py-6 text-xs text-un1t-subtle">
            <CalendarPlus size={20} className="mx-auto mb-2 opacity-40" />
            Consultation + Glofox class booking lands in the next phase.
          </div>
        )}
      </div>
    </div>
  )
}
