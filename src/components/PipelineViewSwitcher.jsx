'use client'

// PIPELINE5.8 — Active vs Dormant tab switcher above the Kanban.
//
// Lives outside the KanbanBoard so the page can SSR each view's
// stages/deals separately. Uses ?view= query param so the operator
// can deep-link to "show me the dormant pile" and bookmark it.
//
// Counts come from server-side count(*) heads — they reflect the
// total in each pile, not just what's rendered (relevant after the
// 5.7 backfill when the dormant pile may be in the thousands).

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Layers, Archive } from 'lucide-react'

const TABS = [
  { id: 'active',  label: 'Active',  Icon: Layers },
  { id: 'dormant', label: 'Dormant', Icon: Archive },
]

export default function PipelineViewSwitcher({ view, activeCount, dormantCount }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function go(target) {
    if (target === view) return
    const next = new URLSearchParams(params?.toString() || '')
    if (target === 'active') next.delete('view')
    else next.set('view', target)
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const counts = { active: activeCount, dormant: dormantCount }

  return (
    <div className="border-b border-un1t-gray flex items-center gap-1 mb-4">
      {TABS.map(({ id, label, Icon }) => {
        const on = view === id
        const count = counts[id] ?? 0
        return (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            className={`relative px-4 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 transition-colors ${
              on
                ? 'border-emerald-500 text-un1t-white'
                : 'border-transparent text-un1t-light hover:text-un1t-white'
            }`}
          >
            <Icon size={14} />
            {label}
            <span className={`ml-1 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 text-[10px] font-semibold rounded-full tabular-nums ${
              on
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-un1t-gray/30 text-un1t-light border border-un1t-gray'
            }`}>
              {count.toLocaleString()}
            </span>
          </button>
        )
      })}
    </div>
  )
}
