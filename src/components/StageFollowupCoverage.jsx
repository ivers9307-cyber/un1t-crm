'use client'

// PIPEBUILD.1f — which stages of the active board have a live follow-up.
// A stage nobody follows up is invisible on the board, so the strip says so.
// Decoration: a failed read renders nothing (and logs once), never a banner.

import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function StageFollowupCoverage({ locationId, pipelineId, canEditSequences = false }) {
  const [stages, setStages] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/stage-coverage`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`stage coverage ${res.status}`)
        const body = await res.json()
        const board = (body?.data?.boards || []).find((b) => b.id === pipelineId)
        if (!cancelled) setStages(board ? board.stages.filter((s) => !s.isPile) : [])
      } catch (err) {
        console.error('stage coverage read failed', err?.message)
        if (!cancelled) setStages(null)
      }
    })()
    return () => { cancelled = true }
  }, [locationId, pipelineId])

  if (!stages || stages.length === 0) return null
  const anyMissing = stages.some((s) => (s.followups || []).length === 0)

  return (
    <div className="mb-4 rounded-md border border-un1t-border bg-un1t-surface px-3 py-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-un1t-muted">Follow-ups by stage</span>
        {anyMissing && canEditSequences && (
          <Link href="/automations" className="text-xs text-un1t-accent underline">Build one</Link>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {stages.map((s) => {
          const f = s.followups || []
          return f.length > 0 ? (
            <span key={s.id} title={f.map((x) => x.name).join(', ')}
              className="rounded-full px-2.5 py-1 text-xs bg-emerald-500/10 text-emerald-700">
              {`${s.name}: ${f.length} follow-up${f.length === 1 ? '' : 's'}`}
            </span>
          ) : (
            <span key={s.id} className="rounded-full px-2.5 py-1 text-xs bg-red-500/10 text-red-700">
              {`${s.name}: no follow-up`}
            </span>
          )
        })}
      </div>
    </div>
  )
}
