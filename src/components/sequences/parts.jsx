// FLOW-GRAPH Phase 2 — small presentational bits shared by the editable
// (FlowEditor) and read-only (SequenceFlowBuilder rail) views.
import { Zap } from 'lucide-react'
import { describeTrigger } from '@/lib/sequences/graph/view'

/** The vertical line connecting two stacked cards. */
export function Connector() {
  return <div className="w-px h-5 bg-un1t-border mx-auto" aria-hidden />
}

/** The "what starts this flow" card at the top of the rail. Read-only — trigger
 *  editing stays on the classic editor (it owns the webhook-token lifecycle). */
export function TriggerCard({ trigger }) {
  return (
    <div className="w-full max-w-md mx-auto flex items-center gap-3 bg-un1t-text/[0.03] border border-un1t-border rounded-lg px-4 py-3">
      <div className="w-9 h-9 rounded-lg bg-un1t-text/10 text-un1t-text flex items-center justify-center shrink-0">
        <Zap size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">Trigger</p>
        <p className="text-sm text-un1t-text truncate">{describeTrigger(trigger)}</p>
      </div>
    </div>
  )
}
