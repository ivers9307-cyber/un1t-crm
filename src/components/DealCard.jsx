'use client'

import Link from 'next/link'
import { User, Clock } from 'lucide-react'

const statusColors = {
  active_trial: 'border-l-green-500',
  cold: 'border-l-gray-500',
  lost_member: 'border-l-red-500',
  member: 'border-l-emerald-500',
  returning: 'border-l-indigo-500',
}

export default function DealCard({ deal }) {
  const contact = deal.contacts || {}
  const borderColor = statusColors[contact.lead_status] || 'border-l-blue-500'

  return (
    <Link
      href={`/contacts/${contact.id || ''}`}
      className={`block bg-un1t-black border border-un1t-gray ${borderColor} border-l-2 rounded-md p-3 mb-2 hover:border-un1t-mid transition-colors cursor-pointer`}
    >
      <p className="text-sm font-medium truncate">{deal.title}</p>
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
    </Link>
  )
}
