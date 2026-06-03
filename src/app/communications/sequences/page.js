// /communications/sequences — drip-flow list. Was /email/sequences.
//
// Renders inside the Communications layout so the sub-tab nav is
// visible. The detail / new / create flows all live in the visual builder at
// /communications/sequences/[id] now; the old /email/sequences/* paths are
// redirect stubs so existing bookmarks keep working.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Zap, Play, Pause, FileEdit, LayoutTemplate } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import SequenceTemplatePicker from '@/components/SequenceTemplatePicker'
import CloneSequenceButton from '@/components/CloneSequenceButton'
import NewSequenceButton from '@/components/sequences/NewSequenceButton'

export const dynamic = 'force-dynamic'

const triggerLabels = {
  manual: 'Manual enrollment',
  booking_created: 'Booking created',
  first_booking: 'First booking',
  status_change: 'Status change',
  event_reminder: 'Event reminder',
  tag_added: 'Tag added',
  race_registered: 'Race registered',
  race_finished: 'Race finished',
  order_completed: 'Order completed',
  order_failed: 'Order failed',
  order_abandoned: 'Order abandoned',
  anniversary: 'Anniversary',
  inactivity: 'Inactivity',
  // FLOW2 (mig 131) — inbound webhook trigger.
  webhook: 'Webhook (inbound)',
}

const statusConfig = {
  draft:  { label: 'Draft',  color: 'bg-gray-500/20 text-gray-400',  icon: FileEdit },
  active: { label: 'Active', color: 'bg-green-500/20 text-green-400', icon: Play },
  paused: { label: 'Paused', color: 'bg-yellow-500/20 text-yellow-400', icon: Pause },
}

export default async function SequencesListPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'email')) redirect('/communications')

  const db = createServerClient()
  const { data: sequences } = await db.from('email_sequences')
    .select('*, sequence_steps(id)')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Sequences</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">Automated drip campaigns triggered by events</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Discoverable gallery link — the SequenceTemplatePicker
              modal stays for muscle memory but the gallery page is
              the new primary surface for browsing templates. */}
          <Link
            href="/communications/sequences/templates"
            className="inline-flex items-center gap-2 border border-un1t-border text-un1t-subtle text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-text hover:border-un1t-muted transition-colors"
          >
            <LayoutTemplate size={16} />
            Browse templates
          </Link>
          <SequenceTemplatePicker />
          <NewSequenceButton className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      </div>

      {(!sequences || sequences.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-10 text-center">
          <Zap size={32} className="mx-auto mb-3 text-un1t-subtle" />
          <h3 className="text-base font-semibold mb-2">No sequences yet</h3>
          <p className="text-sm text-un1t-subtle mb-4">
            Create automated email sequences that trigger on bookings, status changes, or tags.
          </p>
          <NewSequenceButton label="Create Sequence" className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
          {sequences.map(seq => {
            const config = statusConfig[seq.status] || statusConfig.draft
            const StatusIcon = config.icon
            const stepsCount = seq.sequence_steps?.length || 0
            // The row is wrapped in a div (not the link) so the
            // clone button can live alongside without the whole
            // row hijacking its click. The label area stays a Link.
            return (
              <div
                key={seq.id}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-border/20 transition-colors"
              >
                <Link
                  href={`/communications/sequences/${seq.id}`}
                  className="flex items-center gap-4 flex-1 min-w-0"
                >
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
                  {seq.total_enrolled > 0 && (
                    <span className="text-xs text-un1t-subtle">{seq.total_enrolled} enrolled</span>
                  )}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} />
                    {config.label}
                  </span>
                  <CloneSequenceButton sequenceId={seq.id} sequenceName={seq.name} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
