'use client'

// DRAWER.5 — the pipeline contact slide-over.
//
// Opens when /pipeline carries ?contact=<id> (KanbanBoard owns the
// param; DealCard clicks set it) so the board never unmounts and the
// operator never loses their scroll position. Esc, the scrim, and the
// ✕ all close it; ‹ › steps through the open column's deals in board
// order; "Open full profile" goes to /contacts/[id] for deep work.
//
// Data comes from GET /api/contacts/[id]/command-centre?scope=drawer
// in one round trip (contact row, activities, notes, sequences, WA
// window state, composer templates, channel permissions). The panel
// composes the same shared pieces the contact page uses:
// ContactComposer (Note-first) and ContactTimeline.

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { X, ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import PersonHeader from '@/components/PersonHeader'
import PersonActionBar from '@/components/PersonActionBar'
import ContactComposer from '@/components/ContactComposer'
import ContactTimeline from '@/components/contact/ContactTimeline'
import { mergeTimeline, deriveNeedsAttention } from '@/lib/contact-view'
import { nextBookedClass } from '@/lib/pipeline-classifier'

const TONE_CHIP = {
  danger: 'bg-red-500/10 text-red-700',
  warn: 'bg-amber-500/10 text-amber-700',
}

// Compact label/value row for the key-details card. Rows with no value
// drop out rather than render a dash — the drawer is a summary.
function DetailRow({ label, value, href = null }) {
  if (!value) return null
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-un1t-subtle shrink-0">{label}</span>
      {href ? (
        <a href={href} className="font-medium text-un1t-text truncate hover:underline">{value}</a>
      ) : (
        <span className="font-medium text-un1t-text truncate text-right">{value}</span>
      )}
    </div>
  )
}

export default function ContactDrawer({ contactId, columnContactIds = [], locationId, onNavigate, onClose }) {
  const [bundle, setBundle] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/command-centre?scope=drawer`)
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || 'Could not load contact')
        return
      }
      setBundle(j)
    } catch (e) {
      setError(e?.message || 'Could not load contact')
    }
  }, [contactId])

  useEffect(() => {
    setBundle(null)
    load()
  }, [load])

  // Esc closes — matches every other overlay in the app.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const idx = columnContactIds.indexOf(contactId)
  function step(dir) {
    if (columnContactIds.length < 2) return
    const next = columnContactIds[(idx + dir + columnContactIds.length) % columnContactIds.length]
    onNavigate(next)
  }

  const contact = bundle?.contact || null
  const activities = bundle?.activities || []
  const openTasks = activities.filter((a) => a.kind === 'task' && !a.done)
  const timeline = bundle ? mergeTimeline(bundle.notes, activities) : []
  // next_class_at is derived (not a contacts column) — same helper the
  // pipeline page uses server-side.
  const nextClassAt = contact ? nextBookedClass(contact.recent_bookings) : null
  const attention = contact
    ? deriveNeedsAttention({
        contact: { ...contact, next_class_at: nextClassAt },
        openTasks,
      })
    : []
  // Funnel stages carry the credits / next-class chips (DealCard's set).
  const funnel = contact
    ? ['new_lead', 'first_class', 'second_class', 'trial_done'].includes(contact.pipeline_stage_slug)
    : false

  return (
    <>
      {/* Scrim — click to close, board stays visible behind it. */}
      <div
        className="fixed inset-0 bg-black/20 z-30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="fixed inset-y-0 right-0 w-[440px] max-w-[92vw] z-40 bg-un1t-bg border-l border-un1t-border shadow-2xl flex flex-col"
        role="dialog"
        aria-label="Contact panel"
      >
        {/* Header */}
        <div className="flex items-start gap-2 p-4 border-b border-un1t-border">
          <div className="flex-1 min-w-0">
            {contact ? (
              <>
                <PersonHeader
                  name={contact.name}
                  stageSlug={contact.pipeline_stage_slug}
                  linkedCount={1}
                >
                  <PersonActionBar
                    contactId={contact.id}
                    locationId={locationId}
                    actions={['task', 'sequence', 'cold']}
                    isCold={contact.pipeline_stage_slug === 'cold_lead'}
                  />
                </PersonHeader>
                {/* Contact line — phone + email at a glance, clickable. */}
                <p className="text-xs text-un1t-subtle mt-1.5 truncate">
                  {contact.phone && (
                    <a href={`tel:${contact.phone}`} className="hover:text-un1t-text hover:underline">{contact.phone}</a>
                  )}
                  {contact.phone && contact.email && ' · '}
                  {contact.email && (
                    <a href={`mailto:${contact.email}`} className="hover:text-un1t-text hover:underline">{contact.email}</a>
                  )}
                  {!contact.phone && !contact.email && 'No contact details'}
                </p>
              </>
            ) : (
              <div className="h-12 flex items-center text-sm text-un1t-muted">
                {error || 'Loading…'}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close contact panel"
            className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-un1t-subtle hover:text-un1t-text hover:bg-un1t-surface"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <p className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {error}
            </p>
          )}

          {contact && (
            <>
              {/* Status chips — needs-attention + funnel context. */}
              {(attention.length > 0 || (funnel && (nextClassAt || contact.trial_credits_remaining != null))) && (
                <div className="flex flex-wrap gap-1.5">
                  {attention.map((a) => (
                    <span
                      key={a.key}
                      title={a.detail}
                      className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${TONE_CHIP[a.tone] || TONE_CHIP.warn}`}
                    >
                      {a.label}
                    </span>
                  ))}
                  {funnel && nextClassAt && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700">
                      Next: {new Date(nextClassAt).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' })}
                    </span>
                  )}
                  {funnel && contact.trial_credits_remaining != null && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700">
                      {contact.trial_credits_remaining} credit{contact.trial_credits_remaining === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              )}

              {/* Key details — the who-is-this facts without leaving the board. */}
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3 space-y-1">
                <DetailRow label="Phone" value={contact.phone} href={contact.phone ? `tel:${contact.phone}` : null} />
                <DetailRow label="Email" value={contact.email} href={contact.email ? `mailto:${contact.email}` : null} />
                {contact.wa_phone && contact.wa_phone !== contact.phone && (
                  <DetailRow label="WhatsApp" value={contact.wa_phone} />
                )}
                <DetailRow label="Source" value={contact.lead_source || contact.source} />
                <DetailRow label="Created" value={contact.created_at ? new Date(contact.created_at).toLocaleDateString('en-IE') : null} />
                {contact.glofox_membership_plan && (
                  <DetailRow label="Membership" value={contact.glofox_membership_plan} />
                )}
              </div>

              <ContactComposer
                contactId={contact.id}
                contactName={contact.first_name || contact.name}
                contactLocationId={contact.location_id}
                contactEmail={contact.email || null}
                canWhatsApp={bundle.permissions?.whatsapp}
                canSms={bundle.permissions?.sms}
                canEmail={bundle.permissions?.email}
                hasWaPhone={!!(contact.wa_phone || contact.phone)}
                hasPhone={!!contact.phone}
                hasEmail={!!contact.email}
                smsBlocked={!!(contact.sms_status && contact.sms_status !== 'active')}
                emailBlocked={['bounced', 'complained'].includes(contact.email_status)}
                whatsappWindowOpen={bundle.wa?.window_open}
                whatsappWindowExpiresAt={bundle.wa?.window_expires_at}
                templates={bundle.composer_templates}
                onSaved={load}
              />

              {/* Active sequences */}
              {(bundle.sequences || []).length > 0 && (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 flex items-center gap-1.5">
                    <Clock size={12} /> Active sequences
                  </h3>
                  {bundle.sequences.map((s) => (
                    <div key={s.id} className="flex items-center justify-between py-1.5 border-b border-un1t-border last:border-0">
                      <span className="text-sm truncate">{s.email_sequences?.name || 'Sequence'}</span>
                      {s.next_step_at && (
                        <span className="text-xs text-un1t-muted whitespace-nowrap ml-2">
                          next {new Date(s.next_step_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Timeline */}
              <div className="bg-un1t-surface border border-un1t-border rounded-lg">
                <div className="p-4 pb-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Timeline</h3>
                </div>
                <ContactTimeline timeline={timeline} showFilters />
              </div>
            </>
          )}

          {!contact && !error && (
            <div className="space-y-3 animate-pulse" aria-hidden="true">
              <div className="h-24 bg-un1t-surface border border-un1t-border rounded-lg" />
              <div className="h-40 bg-un1t-surface border border-un1t-border rounded-lg" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 p-3 border-t border-un1t-border bg-un1t-surface">
          <Link
            href={`/contacts/${contactId}`}
            className="flex-1 text-center text-xs font-medium px-3 py-2 bg-un1t-text text-un1t-bg rounded-md hover:bg-un1t-accent"
          >
            Open full profile →
          </Link>
          {columnContactIds.length > 1 && (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous contact in column"
                className="w-8 h-8 rounded-md border border-un1t-border flex items-center justify-center text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next contact in column"
                className="w-8 h-8 rounded-md border border-un1t-border flex items-center justify-center text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
