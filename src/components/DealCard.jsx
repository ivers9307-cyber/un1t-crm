'use client'

// Pipeline kanban card. DRAWER.5 — clicking the card body no longer
// hard-navigates to /contacts/[id]; it opens the contact slide-over via
// the onOpenContact callback KanbanBoard provides (which writes the
// ?contact=<id> search param, so back-button and refresh restore the
// drawer). The kebab menu (PersonActionBar) still offers the shared
// per-contact actions without leaving the kanban view.
//
// PERSON-ACTIONS.1 — the bespoke 3-dots menu + "Add to sequence" modal
// that used to live here moved into the reusable PersonActionBar so the
// pipeline card, contact header, etc. share one consistent affordance.

import { User, Clock } from 'lucide-react'
import PersonActionBar from './PersonActionBar'

// PIPE-AGE.1 footer tones — colour keys on the server-derived
// deal.age.tone (time in stage, falling back to time in pipeline).
// Literal classes so the guardrails linter can see them.
const AGE_TONES = {
  quiet: 'text-un1t-subtle',
  warm:  'text-amber-700',
  stale: 'text-red-700',
}

// Keyed on pipeline_stage_slug (FUNNEL.1 taxonomy).
const statusColors = {
  new_lead:     'border-l-blue-500',
  first_class:  'border-l-green-500',
  second_class: 'border-l-teal-500',
  trial_done:   'border-l-amber-500',
  converted:    'border-l-emerald-500',
  member:       'border-l-slate-500',
  pack_member:  'border-l-cyan-600',
  classpass:    'border-l-purple-500',
  gympass:      'border-l-orange-500',
  cold_lead:    'border-l-zinc-600',
  dormant:      'border-l-gray-500',
}

// Funnel columns 1–4 show the next-class badge; Converted and the
// off-funnel stages don't (it'd be noise there).
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])

export default function DealCard({ deal, locationId, stageName, onOpenContact }) {
  const contact = deal.contacts || {}
  const borderColor = statusColors[contact.pipeline_stage_slug] || 'border-l-blue-500'

  // Age footer (PIPE-AGE.1): time in current stage when the mig-458
  // stamp exists, else time in pipeline. Strings are server-derived
  // (toBoardDeal) so SSR and hydration render identical text.
  const age = deal.age || {}
  const ageTone = AGE_TONES[age.tone] || AGE_TONES.quiet
  const primaryAge = age.stage
    ? (age.stage === 'today' ? `Entered ${stageName || 'stage'} today` : `${age.stage} in ${stageName || 'stage'}`)
    : (age.total
      ? (age.backfilled
        ? "In pipeline since May '26"
        : (age.total === 'today' ? 'Joined pipeline today' : `${age.total} in pipeline`))
      : null)
  const secondaryAge = age.stage && age.total
    ? (age.backfilled ? "since May '26" : `${age.total} total`)
    : null

  function openContact() {
    if (!contact.id || !onOpenContact) return
    onOpenContact(contact.id)
  }

  return (
    <div className="relative mb-2">
      <div
        onClick={openContact}
        className={`block bg-un1t-bg border border-un1t-border ${borderColor} border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium truncate flex-1">{deal.title}</p>
          {contact.id && (
            <PersonActionBar
              contactId={contact.id}
              locationId={locationId}
              actions={['message', 'task', 'sequence', 'cold']}
              isCold={contact.pipeline_stage_slug === 'cold_lead'}
            />
          )}
        </div>
        {contact.name && (
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-subtle">
            <User size={12} />
            <span className="truncate">{contact.name}</span>
          </div>
        )}
        {contact.lead_source && (
          <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-un1t-border rounded text-un1t-subtle">
            {contact.lead_source}
          </span>
        )}
        {contact.trial_credits_remaining != null && BADGE_SLUGS.has(contact.pipeline_stage_slug) && (
          <span className="inline-block mt-1.5 ml-1 text-[10px] px-1.5 py-0.5 bg-green-500/10 rounded text-green-700">
            {contact.trial_credits_remaining} credits
          </span>
        )}
        {BADGE_SLUGS.has(contact.pipeline_stage_slug) && (
          contact.next_class_at ? (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-emerald-500/10 rounded text-emerald-700">
              Next: {new Date(contact.next_class_at).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' })}
            </span>
          ) : (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/10 rounded text-red-700">
              No class booked
            </span>
          )
        )}
        {primaryAge && (
          <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-un1t-border text-[10px]">
            <span className={`flex items-center gap-1 min-w-0 ${ageTone}`}>
              <Clock size={11} className="shrink-0" />
              <span className="truncate">{primaryAge}</span>
            </span>
            {secondaryAge && (
              <span className="text-un1t-muted shrink-0">{secondaryAge}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
