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

// Keyed on pipeline_stage_slug (PIPELINE5 + CLASSIFY.2).
const statusColors = {
  new_lead:          'border-l-blue-500',
  active_trial:      'border-l-green-500',
  hot_conversion:    'border-l-amber-500',
  active_member:     'border-l-emerald-500',
  at_risk_member:    'border-l-orange-500',
  classpass_active:  'border-l-purple-500',
  lapsed:            'border-l-red-500',
  dormant:           'border-l-gray-500',
  dormant_classpass: 'border-l-gray-500',
}

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
        {contact.trial_credits_remaining != null && contact.pipeline_stage_slug === 'active_trial' && (
          <span className="inline-block mt-1.5 ml-1 text-[10px] px-1.5 py-0.5 bg-green-900/40 rounded text-green-400">
            {contact.trial_credits_remaining} credits
          </span>
        )}
      </div>
    </div>
  )
}
