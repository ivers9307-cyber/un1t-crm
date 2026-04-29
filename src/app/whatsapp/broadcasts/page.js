import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, ArrowLeft, Megaphone, Send, FileEdit, Clock, Ban } from 'lucide-react'

export const dynamic = 'force-dynamic'

const statusConfig = {
  draft:   { label: 'Draft',   color: 'bg-gray-500/20 text-gray-400',    icon: FileEdit },
  sending: { label: 'Sending', color: 'bg-yellow-500/20 text-yellow-400', icon: Clock },
  sent:    { label: 'Sent',    color: 'bg-green-500/20 text-green-400',  icon: Send },
  cancelled: { label: 'Cancelled', color: 'bg-red-500/20 text-red-400', icon: Ban },
}

export default async function BroadcastsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: broadcasts } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(name, category)')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/whatsapp" className="text-un1t-light hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-2xl font-bold">Broadcasts</h2>
            <p className="text-sm text-un1t-light mt-1">Send template messages to your audience</p>
          </div>
        </div>
        <Link
          href="/whatsapp/broadcasts/new"
          className="flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <Plus size={16} />
          New Broadcast
        </Link>
      </div>

      {(!broadcasts || broadcasts.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Megaphone size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No broadcasts yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create a broadcast to send an approved template message to your contacts
          </p>
          <Link
            href="/whatsapp/broadcasts/new"
            className="inline-flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Plus size={16} />
            Create Broadcast
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {broadcasts.map(broadcast => {
            const config = statusConfig[broadcast.status] || statusConfig.draft
            const StatusIcon = config.icon

            return (
              <Link
                key={broadcast.id}
                href={`/whatsapp/broadcasts/${broadcast.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-gray/30 flex items-center justify-center">
                    <Megaphone size={18} className="text-un1t-light" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{broadcast.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5">
                      Template: {broadcast.whatsapp_templates?.name || 'None'}
                      {broadcast.sent_at && (
                        <span> · Sent {new Date(broadcast.sent_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}</span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {broadcast.status === 'sent' && (
                    <div className="flex items-center gap-3 text-xs text-un1t-light">
                      <span>{broadcast.total_sent || 0} sent</span>
                      <span>{broadcast.total_delivered || 0} delivered</span>
                      <span>{broadcast.total_read || 0} read</span>
                    </div>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${config.color}`}>
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
