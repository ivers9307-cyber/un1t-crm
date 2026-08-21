'use client'

// FUNNEL.1 — tab switcher above the Kanban.
// RETURNPIPE.1 — a third tab, Returning: customers who trained here before and
// came back. They follow a different flow from a new lead (Richard,
// 2026-08-21), so they get their own board rather than a badge on this one.
//
// Lives outside the KanbanBoard so the page can SSR each view's
// stages/deals separately. Uses ?view= query param so the operator
// can deep-link to "show me the off-funnel pile" and bookmark it.
// NOTE: the param value stays `dormant` (bookmarks + the page.js
// branch depend on it) — only the visible labels changed.
//
// Counts come from server-side count(*) heads — they reflect the
// total in each pile, not just what's rendered.

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Layers, Archive, RotateCcw } from 'lucide-react'

const TABS = [
  { id: 'active',    label: 'Funnel',     Icon: Layers },
  { id: 'returning', label: 'Returning',  Icon: RotateCcw },
  { id: 'dormant',   label: 'Off funnel', Icon: Archive },
]

export default function PipelineViewSwitcher({ view, activeCount, dormantCount, returningCount = 0 }) {
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

  const counts = { active: activeCount, returning: returningCount, dormant: dormantCount }

  return (
    <div className="border-b border-un1t-border flex items-center gap-1 mb-4">
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
                ? 'border-emerald-500 text-un1t-text'
                : 'border-transparent text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            <Icon size={14} />
            {label}
            <span className={`ml-1 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 text-[10px] font-semibold rounded-full tabular-nums ${
              on
                ? 'bg-emerald-500/20 text-emerald-700 border border-emerald-500/40'
                : 'bg-un1t-border/30 text-un1t-subtle border border-un1t-border'
            }`}>
              {count.toLocaleString()}
            </span>
          </button>
        )
      })}
    </div>
  )
}
