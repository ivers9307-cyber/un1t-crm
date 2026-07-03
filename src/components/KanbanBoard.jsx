'use client'

import { useState } from 'react'
import DealCard from './DealCard'

// FUNNEL.1 — funnel taxonomy. Hexes match mig 350 stage rows.
const stageColors = {
  new_lead:     '#3B82F6',
  first_class:  '#10B981',
  second_class: '#14B8A6',
  trial_done:   '#F59E0B',
  converted:    '#059669',
  member:       '#64748B',
  pack_member:  '#0891B2',
  classpass:    '#A855F7',
  dormant:      '#6B7280',
}

// PERF.3 — per-column initial render cap. At 8.1k open deals
// concentrated mostly in a couple of stages, mounting every card up
// front blew /pipeline TTI out: each card has a few event listeners
// + an actions-menu state, so 8k cards = 24k+ event-listener attaches
// before the page is interactive. We now render only the first N
// cards per column and let the operator click "Show all" if they
// want the rest. The PER_COLUMN_CAP value is deliberately generous —
// most operator workflows only ever look at the top of each column.
const PER_COLUMN_CAP = 50

// FUNNEL.1 — the board is read-only. Drag-drop was removed
// deliberately: every column is fully classifier-derived (webhook +
// nightly cron), so a manual drag would be silently overwritten by
// the next classify pass.
export default function KanbanBoard({ initialStages, initialDeals, locationId }) {
  // Per-column expand state — operator click on "Show all" flips
  // the stage_id to true and unmasks the rest of that column.
  const [expandedColumns, setExpandedColumns] = useState({})

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
      {initialStages.map(stage => {
        // Cards with no upcoming class sort first — that's the
        // follow-up list; a booked next class means the funnel is
        // working on its own.
        const stageDeals = initialDeals
          .filter(d => d.stage_id === stage.id)
          .sort((a, b) =>
            (a.contacts?.next_class_at ? 1 : 0) - (b.contacts?.next_class_at ? 1 : 0))
        const color = stageColors[stage.slug] || '#6B7280'

        return (
          <div
            key={stage.id}
            className="shrink-0 w-64 bg-un1t-surface rounded-lg border border-un1t-border"
          >
            {/* Stage Header */}
            <div className="flex items-center gap-2 p-3 border-b border-un1t-border">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <h3 className="text-xs font-semibold uppercase tracking-wider truncate">{stage.name}</h3>
              <span className="ml-auto text-xs text-un1t-subtle bg-un1t-border px-1.5 rounded">
                {stageDeals.length}
              </span>
            </div>

            {/* Deal Cards — render only the first PER_COLUMN_CAP
                unless the operator has clicked "Show all" for this
                column. Mirrors the count badge on the stage header
                so the operator can see what's hidden. */}
            <div className="p-2 space-y-0 min-h-[100px]">
              {(expandedColumns[stage.id] ? stageDeals : stageDeals.slice(0, PER_COLUMN_CAP)).map(deal => (
                <DealCard key={deal.id} deal={deal} locationId={locationId} />
              ))}
              {!expandedColumns[stage.id] && stageDeals.length > PER_COLUMN_CAP && (
                <button
                  type="button"
                  onClick={() => setExpandedColumns((p) => ({ ...p, [stage.id]: true }))}
                  className="w-full mt-1 py-1.5 text-[11px] text-un1t-subtle hover:text-un1t-text border border-dashed border-un1t-border rounded-md hover:border-un1t-subtle transition-colors"
                >
                  Show all {stageDeals.length} (+{stageDeals.length - PER_COLUMN_CAP} hidden)
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
