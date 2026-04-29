import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, Mail, Send, Clock, FileEdit, Ban, BarChart3 } from 'lucide-react'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const statusConfig = {
  draft:     { label: 'Draft',     color: 'bg-gray-500/20 text-gray-400',    icon: FileEdit },
  scheduled: { label: 'Scheduled', color: 'bg-blue-500/20 text-blue-400',    icon: Clock },
  sending:   { label: 'Sending',   color: 'bg-yellow-500/20 text-yellow-400', icon: Send },
  sent:      { label: 'Sent',      color: 'bg-green-500/20 text-green-400',  icon: Mail },
  cancelled: { label: 'Cancelled', color: 'bg-red-500/20 text-red-400',      icon: Ban },
}

export default async function EmailPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const locationId = user.activeLocation?.id
  const filter = searchParams?.filter || 'all'

  // Get campaigns
  let campaignQuery = db.from('campaigns')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (filter !== 'all') campaignQuery = campaignQuery.eq('status', filter)

  const { data: campaigns } = await campaignQuery

  // Get sequences
  const { data: sequences } = await db.from('email_sequences')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })

  // Get email stats for this location
  const { count: totalSent } = await db.from('email_sends')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)

  const { count: totalOpened } = await db.from('email_sends')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('opened_at', 'is', null)

  const openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0

  const filters = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Drafts' },
    { key: 'sent', label: 'Sent' },
    { key: 'scheduled', label: 'Scheduled' },
  ]

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Email Marketing</h2>
          <p className="text-sm text-un1t-light mt-1">Campaigns, sequences, and analytics</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/email/templates"
            className="flex items-center gap-2 border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            Templates
          </Link>
          <Link
            href="/email/sequences"
            className="flex items-center gap-2 border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            Sequences
          </Link>
          <Link
            href="/email/campaigns/new"
            className="flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} />
            New Campaign
          </Link>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light uppercase tracking-wider">Campaigns</p>
          <p className="text-2xl font-bold mt-1">{(campaigns || []).length}</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light uppercase tracking-wider">Sequences</p>
          <p className="text-2xl font-bold mt-1">{(sequences || []).length}</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light uppercase tracking-wider">Emails Sent</p>
          <p className="text-2xl font-bold mt-1">{totalSent || 0}</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light uppercase tracking-wider">Open Rate</p>
          <p className="text-2xl font-bold mt-1">{openRate}%</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-5">
        {filters.map(f => (
          <Link
            key={f.key}
            href={`/email${f.key !== 'all' ? `?filter=${f.key}` : ''}`}
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

      {/* Campaigns List */}
      {(!campaigns || campaigns.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Mail size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No campaigns yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create your first email campaign to start reaching your contacts
          </p>
          <Link
            href="/email/campaigns/new"
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} />
            Create Campaign
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {campaigns.map(campaign => {
            const config = statusConfig[campaign.status] || statusConfig.draft
            const StatusIcon = config.icon

            return (
              <Link
                key={campaign.id}
                href={`/email/campaigns/${campaign.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-gray/30 flex items-center justify-center">
                    <StatusIcon size={18} className="text-un1t-light" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{campaign.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5">
                      {campaign.subject || 'No subject'}
                      {campaign.sent_at && (
                        <span> · Sent {new Date(campaign.sent_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}</span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {campaign.status === 'sent' && (
                    <div className="flex items-center gap-3 text-xs text-un1t-light">
                      <span>{campaign.total_sent || 0} sent</span>
                      <span>{campaign.total_opened || 0} opened</span>
                      <span>{campaign.total_clicked || 0} clicked</span>
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
