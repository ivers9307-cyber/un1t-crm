'use client'

// Pipeline kanban card. Click anywhere on the card body navigates to the
// contact detail page; the kebab menu (PersonActionBar) offers the
// shared per-contact actions — Message / Task / Sequence — without
// leaving the kanban view.
//
// Implementation note: we used to wrap the entire card in a <Link>, but
// adding a menu button inside that link would make the menu also navigate
// on click. Switched to programmatic navigation via useRouter so the
// menu button (PersonActionBar, which stops propagation internally) can
// sit inside the clickable body cleanly.
//
// PERSON-ACTIONS.1 — the bespoke 3-dots menu + "Add to sequence" modal
// that used to live here moved into the reusable PersonActionBar so the
// pipeline card, contact header, etc. share one consistent affordance.

import { useRouter } from 'next/navigation'
import { User } from 'lucide-react'
import PersonActionBar from './PersonActionBar'

// Keyed on pipeline_stage_slug (FUNNEL.1 taxonomy).
const statusColors = {
  new_lead:     'border-l-blue-500',
  first_class:  'border-l-green-500',
  second_class: 'border-l-teal-500',
  trial_done:   'border-l-amber-500',
  converted:    'border-l-emerald-500',
  member:       'border-l-slate-500',
  classpass:    'border-l-purple-500',
  dormant:      'border-l-gray-500',
}

// Funnel columns 1–4 show the next-class badge; Converted and the
// off-funnel stages don't (it'd be noise there).
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])

export default function DealCard({ deal, locationId }) {
  const router = useRouter()
  const contact = deal.contacts || {}
  const borderColor = statusColors[contact.pipeline_stage_slug] || 'border-l-blue-500'

  function navigateToContact() {
    if (!contact.id) return
    router.push(`/contacts/${contact.id}`)
  }

  return (
    <div className="relative mb-2">
      <div
        onClick={navigateToContact}
        className={`block bg-un1t-bg border border-un1t-border ${borderColor} border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium truncate flex-1">{deal.title}</p>
          {contact.id && (
            <PersonActionBar contactId={contact.id} locationId={locationId} />
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
      </div>
    </div>
  )
}
