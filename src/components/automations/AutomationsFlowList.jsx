// "Your automations" — the custom flow list on the /automations home.
// Lifted from the retired /communications/sequences list page; rows link
// to the re-homed editor at /automations/[id]. Server component; the
// action buttons it renders are client components.
import Link from 'next/link'
import { Zap, Play, Pause, FileEdit, LayoutTemplate } from 'lucide-react'
import SequenceTemplatePicker from '@/components/SequenceTemplatePicker'
import NewSequenceButton from '@/components/sequences/NewSequenceButton'
import CloneSequenceButton from '@/components/CloneSequenceButton'
import DeleteSequenceButton from '@/components/sequences/DeleteSequenceButton'

const triggerLabels = {
  manual: 'Manual enrollment', booking_created: 'Booking created', first_booking: 'First booking',
  status_change: 'Status change', pipeline_stage_change: 'Pipeline stage change',
  membership_state_change: 'Membership state change', contact_created: 'New lead created',
  event_reminder: 'Event reminder', tag_added: 'Tag added',
  segment_added: 'Segment entered', segment_removed: 'Segment exited',
  race_registered: 'Race registered', race_finished: 'Race finished',
  order_completed: 'Order completed', order_failed: 'Order failed', order_abandoned: 'Order abandoned',
  anniversary: 'Anniversary', inactivity: 'Inactivity', webhook: 'Webhook (inbound)',
}
const statusConfig = {
  draft:  { label: 'Draft',  color: 'bg-un1t-border/40 text-un1t-subtle', icon: FileEdit },
  active: { label: 'Active', color: 'bg-emerald-500/15 text-emerald-700', icon: Play },
  paused: { label: 'Paused', color: 'bg-amber-500/15 text-amber-700', icon: Pause },
}

export default function AutomationsFlowList({ sequences }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-un1t-text">Your automations</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">Custom flows triggered by events — build your own with steps + branches</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/automations/templates"
            className="inline-flex items-center gap-2 border border-un1t-border text-un1t-subtle text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-text hover:border-un1t-muted transition-colors"
          >
            <LayoutTemplate size={16} />
            Browse recipes
          </Link>
          <SequenceTemplatePicker />
          <NewSequenceButton className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      </div>

      {(!sequences || sequences.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-10 text-center">
          <Zap size={32} className="mx-auto mb-3 text-un1t-subtle" />
          <h3 className="text-base font-semibold mb-2">No automations yet</h3>
          <p className="text-sm text-un1t-subtle mb-4">Build a flow that triggers on bookings, new leads, stage changes, or tags.</p>
          <NewSequenceButton label="Build an automation" className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
          {sequences.map(seq => {
            const config = statusConfig[seq.status] || statusConfig.draft
            const StatusIcon = config.icon
            const stepsCount = seq.sequence_steps?.length || 0
            return (
              <div key={seq.id} className="flex items-center justify-between px-5 py-4 hover:bg-un1t-border/20 transition-colors">
                <Link href={`/automations/${seq.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-un1t-border/30 flex items-center justify-center shrink-0">
                    <Zap size={18} className="text-un1t-subtle" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{seq.name}</p>
                    <p className="text-xs text-un1t-subtle mt-0.5">
                      {triggerLabels[seq.trigger_type] || seq.trigger_type} · {stepsCount} step{stepsCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  {seq.total_enrolled > 0 && (<span className="text-xs text-un1t-subtle">{seq.total_enrolled} enrolled</span>)}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} />{config.label}
                  </span>
                  <CloneSequenceButton sequenceId={seq.id} sequenceName={seq.name} />
                  <DeleteSequenceButton sequenceId={seq.id} sequenceName={seq.name} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
