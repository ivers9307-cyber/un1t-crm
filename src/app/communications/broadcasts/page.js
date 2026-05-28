// /communications/broadcasts — WhatsApp broadcasts list. Was
// /whatsapp/broadcasts. Detail/new pages still live at the old
// /whatsapp/broadcasts/[id] path for now.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, Megaphone, Send, FileEdit, Clock, Ban } from 'lucide-react'
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

export default async function BroadcastsListPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'whatsapp')) redirect('/communications')

  const db = createServerClient()
  const { data: broadcasts } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(name, category)')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Broadcasts</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">Send approved template messages to filtered audiences</p>
        </div>
        <Link
          href="/whatsapp/broadcasts/new"
          className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} />
          New Broadcast
        </Link>
      </div>

      {(!broadcasts || broadcasts.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-10 text-center">
          <Megaphone size={32} className="mx-auto mb-3 text-un1t-subtle" />
          <h3 className="text-base font-semibold mb-2">No broadcasts yet</h3>
          <p className="text-sm text-un1t-subtle mb-4">
            Create a broadcast to send an approved template message to your contacts.
          </p>
          <Link
            href="/whatsapp/broadcasts/new"
            className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} /> Create Broadcast
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
          {broadcasts.map(b => {
            const config = statusConfig[b.status] || statusConfig.draft
            const StatusIcon = config.icon
            return (
              <Link
                key={b.id}
                href={`/whatsapp/broadcasts/${b.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-border/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-border/30 flex items-center justify-center">
                    <Megaphone size={18} className="text-un1t-subtle" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{b.name}</p>
                    <p className="text-xs text-un1t-subtle mt-0.5">
                      Template: {b.whatsapp_templates?.name || 'None'}
                      {b.sent_at && <span> · Sent {new Date(b.sent_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {b.status === 'sent' && (
                    <div className="flex items-center gap-3 text-xs text-un1t-subtle">
                      <span>{b.total_sent || 0} sent</span>
                      <span>{b.total_delivered || 0} delivered</span>
                      <span>{b.total_read || 0} read</span>
                    </div>
                  )}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} /> {config.label}
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
