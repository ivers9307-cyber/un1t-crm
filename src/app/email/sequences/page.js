import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, ArrowLeft, Zap, Play, Pause, FileEdit } from 'lucide-react'

export const dynamic = 'force-dynamic'

const triggerLabels = {
  manual: 'Manual enrollment',
  booking_created: 'Booking created',
  status_change: 'Status change',
  event_reminder: 'Event reminder',
  tag_added: 'Tag added',
}

const statusConfig = {
  draft:  { label: 'Draft',  color: 'bg-gray-500/20 text-gray-400',  icon: FileEdit },
  active: { label: 'Active', color: 'bg-green-500/20 text-green-400', icon: Play },
  paused: { label: 'Paused', color: 'bg-yellow-500/20 text-yellow-400', icon: Pause },
}

export default async function SequencesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: sequences } = await db.from('email_sequences')
    .select('*, sequence_steps(id)')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/email" className="text-un1t-light hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-2xl font-bold">Email Sequences</h2>
            <p className="text-sm text-un1t-light mt-1">Automated drip campaigns triggered by events</p>
          </div>
        </div>
        <Link
          href="/email/sequences/new"
          className="flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <Plus size={16} />
          New Sequence
        </Link>
      </div>

      {(!sequences || sequences.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Zap size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No sequences yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create automated email sequences that trigger based on events like bookings, status changes, or tags
          </p>
          <Link
            href="/email/sequences/new"
            className="inline-flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Plus size={16} />
            Create Sequence
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {sequences.map(seq => {
            const config = statusConfig[seq.status] || statusConfig.draft
            const StatusIcon = config.icon
            const stepsCount = seq.sequence_steps?.length || 0

            return (
              <Link
                key={seq.id}
                href={`/email/sequences/${seq.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-gray/30 flex items-center justify-center">
                    <Zap size={18} className="text-un1t-light" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{seq.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5">
                      {triggerLabels[seq.trigger_type] || seq.trigger_type} · {stepsCount} step{stepsCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {seq.total_enrolled > 0 && (
                    <span className="text-xs text-un1t-light">{seq.total_enrolled} enrolled</span>
                  )}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} />
                    {config.label}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
