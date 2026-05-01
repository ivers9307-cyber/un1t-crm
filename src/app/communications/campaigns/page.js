// /communications/campaigns — email campaigns list. Extracted from
// the old /email hub page.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, Mail, Send, Clock, FileEdit, Ban } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const statusConfig = {
  draft:     { label: 'Draft',     color: 'bg-gray-500/20 text-gray-400',     icon: FileEdit },
  scheduled: { label: 'Scheduled', color: 'bg-blue-500/20 text-blue-400',     icon: Clock },
  sending:   { label: 'Sending',   color: 'bg-yellow-500/20 text-yellow-400', icon: Send },
  sent:      { label: 'Sent',      color: 'bg-green-500/20 text-green-400',   icon: Mail },
  cancelled: { label: 'Cancelled', color: 'bg-red-500/20 text-red-400',       icon: Ban },
}

const filters = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Sent' },
  { key: 'scheduled', label: 'Scheduled' },
]

export default async function CampaignsListPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'email')) redirect('/communications')

  const db = createServerClient()
  const filter = searchParams?.filter || 'all'

  let query = db.from('campaigns')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (filter !== 'all') query = query.eq('status', filter)
  const { data: campaigns } = await query

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Campaigns</h2>
          <p className="text-xs text-un1t-light mt-0.5">One-off email blasts to filtered audiences</p>
        </div>
        <Link
          href="/email/campaigns/new"
          className="flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} /> New Campaign
        </Link>
      </div>

      <div className="flex gap-2 mb-4">
        {filters.map(f => (
          <Link
            key={f.key}
            href={`/communications/campaigns${f.key !== 'all' ? `?filter=${f.key}` : ''}`}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
              filter === f.key
                ? 'bg-un1t-white text-un1t-black'
                : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {(!campaigns || campaigns.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-10 text-center">
          <Mail size={32} className="mx-auto mb-3 text-un1t-light" />
          <h3 className="text-base font-semibold mb-2">No campaigns yet</h3>
          <p className="text-sm text-un1t-light mb-4">Create your first email campaign to start reaching your contacts.</p>
          <Link
            href="/email/campaigns/new"
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} /> Create Campaign
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl divide-y divide-un1t-gray">
          {campaigns.map(c => {
            const config = statusConfig[c.status] || statusConfig.draft
            const StatusIcon = config.icon
            return (
              <Link
                key={c.id}
                href={`/email/campaigns/${c.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-gray/30 flex items-center justify-center">
                    <StatusIcon size={18} className="text-un1t-light" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5">
                      {c.subject || 'No subject'}
                      {c.sent_at && <span> · Sent {new Date(c.sent_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {c.status === 'sent' && (
                    <div className="flex items-center gap-3 text-xs text-un1t-light">
                      <span>{c.total_sent || 0} sent</span>
                      <span>{c.total_opened || 0} opened</span>
                      <span>{c.total_clicked || 0} clicked</span>
                    </div>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${config.color}`}>{config.label}</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
