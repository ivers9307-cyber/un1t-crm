'use client'

// FUNNEL.1 — tab switcher above the Kanban.
//
// PIPELINES.6 — two rows, both driven by the URL:
//
//   Board row — one tab per row in `pipelines` (the location's enabled boards,
//     in display_order), writing ?pipeline=<key>. It renders ONLY when the
//     location has more than one board: a tab bar with a single tab is noise,
//     and today every location has exactly one enabled board (Stillorgan's
//     Returning is parked, and CCF Autos / SourceIt / Test Studio are disabled
//     entirely). The multi-board path is live code, just unexercised.
//
//   View row — the original Funnel / Off funnel toggle, rendered only for a
//     DERIVED board. A manual board has nothing off funnel: a human decides
//     where each card sits, so every column is one view.
//
// Switching board DELETES ?view. A view belongs to a board — carrying
// `dormant` onto a board that has no dormant column would land the operator on
// an empty screen with a tab lit up that the new board never offered.
//
// NOTE: the view param value stays `dormant` (operators have bookmarked it,
// and page.js branches on it) — only the visible labels ever changed.
//
// Counts come from server-side count(*) heads — they reflect the total in each
// pile, not just what's rendered.

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Layers, Archive } from 'lucide-react'

const VIEWS = [
  { id: 'active',  label: 'Funnel',     Icon: Layers },
  { id: 'dormant', label: 'Off funnel', Icon: Archive },
]

const tabClass = (on) =>
  `relative px-4 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 transition-colors ${
    on
      ? 'border-emerald-500 text-un1t-text'
      : 'border-transparent text-un1t-subtle hover:text-un1t-text'
  }`

const badgeClass = (on) =>
  `ml-1 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 text-[10px] font-semibold rounded-full tabular-nums ${
    on
      ? 'bg-emerald-500/20 text-emerald-700 border border-emerald-500/40'
      : 'bg-un1t-border/30 text-un1t-subtle border border-un1t-border'
  }`

export default function PipelineViewSwitcher({
  pipelines = [],
  activePipelineKey = null,
  isManual = false,
  view,
  activeCount,
  dormantCount,
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function push(next) {
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  function goBoard(key) {
    if (key === activePipelineKey) return
    const next = new URLSearchParams(params?.toString() || '')
    next.set('pipeline', key)
    // A view never travels between boards.
    next.delete('view')
    push(next)
  }

  function goView(target) {
    if (target === view) return
    const next = new URLSearchParams(params?.toString() || '')
    if (target === 'active') next.delete('view')
    else next.set('view', target)
    push(next)
  }

  const counts = { active: activeCount, dormant: dormantCount }

  return (
    <>
      {pipelines.length > 1 && (
        <div className="border-b border-un1t-border flex items-center gap-1 mb-4">
          {pipelines.map((p) => {
            const on = p.key === activePipelineKey
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => goBoard(p.key)}
                className={tabClass(on)}
              >
                {p.name}
              </button>
            )
          })}
        </div>
      )}

      {!isManual && (
        <div className="border-b border-un1t-border flex items-center gap-1 mb-4">
          {VIEWS.map(({ id, label, Icon }) => {
            const on = view === id
            const count = counts[id] ?? 0
            return (
              <button
                key={id}
                type="button"
                onClick={() => goView(id)}
                className={tabClass(on)}
              >
                <Icon size={14} />
                {label}
                <span className={badgeClass(on)}>{count.toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
