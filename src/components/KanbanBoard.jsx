'use client'

import { useState } from 'react'
import DealCard from './DealCard'
import { createBrowserClient } from '@/lib/supabase'

// Stage dot colors. PIPELINE5.8 introduces the new engagement-aware
// taxonomy (top block) — these match the hex values in mig 147 so
// the column dot agrees with whatever the operator picked in the
// stage settings. The legacy block stays for the transition period
// (stages still exist + may carry deals until the 5.7 backfill +
// the post-5.7 cleanup migration archives them).
const stageColors = {
  // PIPELINE5.x taxonomy
  new_lead:           '#3B82F6',
  active_trial:       '#10B981',
  hot_conversion:     '#F59E0B',
  active_member:      '#059669',
  at_risk_member:     '#EAB308',
  classpass_active:   '#A855F7',
  lapsed:             '#EF4444',
  dormant:            '#6B7280',
  dormant_classpass:  '#94A3B8',
  // Legacy stages — kept until cleanup migration retires them
  new_lead_social:    '#8B5CF6',
  trial_active:       '#10B981',
  conversion_ready:   '#F59E0B',
  follow_up_needed:   '#EF4444',
  member:             '#059669',
  cold_email_only:    '#9CA3AF',
  lost_member:        '#DC2626',
  returning_member:   '#6366F1',
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

export default function KanbanBoard({ initialStages, initialDeals, locationId }) {
  const [deals, setDeals] = useState(initialDeals)
  const [draggedDeal, setDraggedDeal] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)
  // Per-column expand state — operator click on "Show all" flips
  // the stage_id to true and unmasks the rest of that column. Drag
  // operations are unaffected: the deal data is in state, just
  // un-rendered, so it can still move.
  const [expandedColumns, setExpandedColumns] = useState({})

  async function handleDrop(stageId) {
    if (!draggedDeal || draggedDeal.stage_id === stageId) {
      setDraggedDeal(null)
      setDragOverStage(null)
      return
    }

    // Optimistic update
    setDeals(prev =>
      prev.map(d => d.id === draggedDeal.id ? { ...d, stage_id: stageId } : d)
    )

    // Persist to Supabase
    const db = createBrowserClient()
    await db.from('deals').update({ stage_id: stageId }).eq('id', draggedDeal.id)

    setDraggedDeal(null)
    setDragOverStage(null)
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
      {initialStages.map(stage => {
        const stageDeals = deals.filter(d => d.stage_id === stage.id)
        const color = stageColors[stage.slug] || '#6B7280'
        const isOver = dragOverStage === stage.id

        return (
          <div
            key={stage.id}
            className={`shrink-0 w-64 bg-un1t-dark rounded-lg border transition-colors ${
              isOver ? 'border-un1t-white/40' : 'border-un1t-gray'
            }`}
            onDragOver={e => { e.preventDefault(); setDragOverStage(stage.id) }}
            onDragLeave={() => setDragOverStage(null)}
            onDrop={() => handleDrop(stage.id)}
          >
            {/* Stage Header */}
            <div className="flex items-center gap-2 p-3 border-b border-un1t-gray">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <h3 className="text-xs font-semibold uppercase tracking-wider truncate">{stage.name}</h3>
              <span className="ml-auto text-xs text-un1t-light bg-un1t-gray px-1.5 rounded">
                {stageDeals.length}
              </span>
            </div>

            {/* Deal Cards — render only the first PER_COLUMN_CAP
                unless the operator has clicked "Show all" for this
                column. Mirrors the count badge on the stage header
                so the operator can see what's hidden. */}
            <div className="p-2 space-y-0 min-h-[100px]">
              {(expandedColumns[stage.id] ? stageDeals : stageDeals.slice(0, PER_COLUMN_CAP)).map(deal => (
                <div
                  key={deal.id}
                  draggable
                  onDragStart={() => setDraggedDeal(deal)}
                  onDragEnd={() => { setDraggedDeal(null); setDragOverStage(null) }}
                  className={`${draggedDeal?.id === deal.id ? 'opacity-40' : ''}`}
                >
                  <DealCard deal={deal} locationId={locationId} />
                </div>
              ))}
              {!expandedColumns[stage.id] && stageDeals.length > PER_COLUMN_CAP && (
                <button
                  type="button"
                  onClick={() => setExpandedColumns((p) => ({ ...p, [stage.id]: true }))}
                  className="w-full mt-1 py-1.5 text-[11px] text-un1t-light hover:text-un1t-white border border-dashed border-un1t-gray rounded-md hover:border-un1t-light transition-colors"
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
