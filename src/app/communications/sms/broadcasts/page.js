// /communications/sms/broadcasts — SMS broadcasts list.
//
// Mirrors /communications/broadcasts (which is WA-only). SMS gets
// its own subpath since it has its own audience-status field
// (sms_status), its own sender ID model (per-location alpha), and
// its own composer (freeform body, no template approval).

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, MessageSquare, Send, FileEdit, Clock, Ban } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const statusConfig = {
  draft:     { label: 'Draft',     color: 'bg-gray-500/20 text-gray-400',     icon: FileEdit },
  sending:   { label: 'Sending',   color: 'bg-yellow-500/20 text-yellow-400', icon: Clock },
  sent:      { label: 'Sent',      color: 'bg-green-500/20 text-green-400',   icon: Send },
  cancelled: { label: 'Cancelled', color: 'bg-red-500/20 text-red-400',       icon: Ban },
}

export default async function SmsBroadcastsListPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'sms')) redirect('/communications')

  const db = createServerClient()
  const { data: broadcasts } = await db
    .from('sms_broadcasts')
    .select('id, name, body, status, scheduled_at, sent_at, total_recipients, total_sent, total_failed, created_at')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">SMS Broadcasts</h2>
          <p className="text-xs text-un1t-light mt-0.5">
            One-off SMS sends to a filtered audience. Sender ID:{' '}
            <code className="text-un1t-white">
              {user.activeLocation?.twilio_alpha_sender_id || 'not set — using fallback'}
            </code>
          </p>
        </div>
        <Link
          href="/communications/sms/broadcasts/new"
          className="flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} />
          New SMS Broadcast
        </Link>
      </div>

      {(!broadcasts || broadcasts.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-10 text-center">
          <MessageSquare size={32} className="mx-auto mb-3 text-un1t-light" />
          <h3 className="text-base font-semibold mb-2">No SMS broadcasts yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create a broadcast to send a freeform SMS to a filtered audience at this location.
          </p>
          <Link
            href="/communications/sms/broadcasts/new"
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} /> Create SMS Broadcast
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl divide-y divide-un1t-gray">
          {broadcasts.map(b => {
            const config = statusConfig[b.status] || statusConfig.draft
            const StatusIcon = config.icon
            return (
              <Link
                key={b.id}
                href={`/communications/sms/broadcasts/${b.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0">
                    <MessageSquare size={18} className="text-cyan-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{b.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5 truncate">
                      {b.body.length > 80 ? b.body.slice(0, 80) + '…' : b.body}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-4">
                  {b.status === 'sent' && (
                    <span className="text-xs text-un1t-light">
                      {b.total_sent}/{b.total_recipients} sent
                      {b.total_failed > 0 && (
                        <span className="text-red-400 ml-1">({b.total_failed} failed)</span>
                      )}
                    </span>
                  )}
                  <span className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${config.color}`}>
                    <StatusIcon size={12} />
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
