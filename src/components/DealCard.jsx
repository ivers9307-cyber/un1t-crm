'use client'

// Pipeline kanban card. Click anywhere on the card body navigates to the
// contact detail page; the 3-dots menu lets you do quick actions
// (currently: Add to sequence) without leaving the kanban view.
//
// Implementation note: we used to wrap the entire card in a <Link>, but
// adding a menu button inside that link would make the menu also navigate
// on click. Switched to programmatic navigation via useRouter so the
// menu button can stop propagation cleanly.

import { useRouter } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { User, MoreVertical } from 'lucide-react'
import SequencePicker from './SequencePicker'

const statusColors = {
  active_trial: 'border-l-green-500',
  cold: 'border-l-gray-500',
  lost_member: 'border-l-red-500',
  member: 'border-l-emerald-500',
  returning: 'border-l-indigo-500',
}

export default function DealCard({ deal, locationId }) {
  const router = useRouter()
  const contact = deal.contacts || {}
  const borderColor = statusColors[contact.lead_status] || 'border-l-blue-500'

  const [menuOpen, setMenuOpen] = useState(false)
  const [picker, setPicker] = useState(false)
  const menuRef = useRef(null)

  // Close menu on outside click. The picker has its own dismiss button.
  useEffect(() => {
    if (!menuOpen) return
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  function navigateToContact() {
    if (!contact.id) return
    router.push(`/contacts/${contact.id}`)
  }

  return (
    <div className="relative mb-2">
      <div
        onClick={navigateToContact}
        className={`block bg-un1t-black border border-un1t-gray ${borderColor} border-l-2 rounded-md p-3 hover:border-un1t-mid transition-colors cursor-pointer`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium truncate flex-1">{deal.title}</p>
          {contact.id && (
            <button
              ref={menuRef}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
              className="shrink-0 text-un1t-light hover:text-un1t-white p-0.5 -m-0.5 rounded"
              title="Actions"
            >
              <MoreVertical size={14} />
            </button>
          )}
        </div>
        {contact.name && (
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-light">
            <User size={12} />
            <span className="truncate">{contact.name}</span>
          </div>
        )}
        {contact.lead_source && (
          <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-un1t-gray rounded text-un1t-light">
            {contact.lead_source}
          </span>
        )}
        {contact.trial_credits_remaining != null && contact.lead_status === 'active_trial' && (
          <span className="inline-block mt-1.5 ml-1 text-[10px] px-1.5 py-0.5 bg-green-900/40 rounded text-green-400">
            {contact.trial_credits_remaining} credits
          </span>
        )}
      </div>

      {menuOpen && (
        <div className="absolute right-1 top-8 z-20 bg-un1t-dark border border-un1t-gray rounded-md shadow-lg py-1 min-w-[160px]">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setPicker(true) }}
            className="w-full text-left px-3 py-1.5 text-xs text-un1t-white hover:bg-un1t-gray/40"
          >
            Add to sequence
          </button>
        </div>
      )}

      {picker && contact.id && (
        <div className="absolute right-0 top-8 z-30" onClick={(e) => e.stopPropagation()}>
          <SequencePicker
            contactIds={[contact.id]}
            locationId={locationId}
            variant="popover"
            onClose={() => setPicker(false)}
          />
        </div>
      )}
    </div>
  )
}
