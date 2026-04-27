'use client'

import { useState } from 'react'
import DealCard from './DealCard'
import { createBrowserClient } from '@/lib/supabase'

const stageColors = {
  new_lead: '#3B82F6',
  new_lead_social: '#8B5CF6',
  trial_active: '#10B981',
  conversion_ready: '#F59E0B',
  follow_up_needed: '#EF4444',
  member: '#059669',
  cold_email_only: '#9CA3AF',
  lost_member: '#DC2626',
  returning_member: '#6366F1',
}

export default function KanbanBoard({ initialStages, initialDeals }) {
  const [deals, setDeals] = useState(initialDeals)
  const [draggedDeal, setDraggedDeal] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)

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
              isOver ? 'border-white/40' : 'border-un1t-gray'
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

            {/* Deal Cards */}
            <div className="p-2 space-y-0 min-h-[100px]">
              {stageDeals.map(deal => (
                <div
                  key={deal.id}
                  draggable
                  onDragStart={() => setDraggedDeal(deal)}
                  onDragEnd={() => { setDraggedDeal(null); setDragOverStage(null) }}
                  className={`${draggedDeal?.id === deal.id ? 'opacity-40' : ''}`}
                >
                  <DealCard deal={deal} />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
