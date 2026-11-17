'use client'

// INBOXASSIGN.1 — Anyone / Mine / Unassigned, the owner filter for an inbox
// list. Presentational: the list decides what the filter means for its rows.

import { OWNER_FILTERS } from '@/lib/inbox-owner'

export default function OwnerFilter({ value = 'any', onChange, className = '' }) {
  return (
    <div role="group" aria-label="Filter by owner" className={`flex items-center gap-1 ${className}`}>
      {OWNER_FILTERS.map(f => (
        <button
          key={f.id}
          type="button"
          aria-pressed={value === f.id}
          onClick={() => onChange?.(f.id)}
          className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
            value === f.id
              ? 'border-transparent bg-un1t-text text-un1t-bg'
              : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}
