import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, Target, Clock, TrendingUp } from 'lucide-react'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

async function getStats(locationId) {
  const db = createServerClient()

  const [contacts, activeTrials, activitiesDue, recentLeads] = await Promise.all([
    db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', locationId),
    db.from('contacts').select('id', { count: 'exact', head: true }).eq('lead_status', 'active_trial').eq('location_id', locationId),
    db.from('activities').select('id', { count: 'exact', head: true }).eq('done', false).lte('due_date', new Date().toISOString().split('T')[0]).eq('location_id', locationId),
    db.from('contacts').select('id, name, lead_source, lead_status, created_at').eq('location_id', locationId).order('created_at', { ascending: false }).limit(8),
  ])

  return {
    totalContacts: contacts.count || 0,
    activeTrials: activeTrials.count || 0,
    overdueActivities: activitiesDue.count || 0,
    recentLeads: recentLeads.data || [],
  }
}

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const stats = await getStats(user.activeLocation?.id)

  const cards = [
    { label: 'Total Contacts', value: stats.totalContacts, icon: Users, color: 'text-blue-400' },
    { label: 'Active Trials', value: stats.activeTrials, icon: Target, color: 'text-green-400' },
    { label: 'Overdue Tasks', value: stats.overdueActivities, icon: Clock, color: 'text-red-400' },
  ]

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      {/* Stat Cards */}
      <div className="grid grid-cols-3 gap-5 mb-8">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-un1t-light">{label}</span>
              <Icon size={20} className={color} />
            </div>
            <p className="text-3xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      {/* Recent Leads */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg">
        <div className="flex items-center justify-between p-5 border-b border-un1t-gray">
          <h3 className="font-semibold">Recent Leads</h3>
          <Link href="/contacts" className="text-sm text-un1t-light hover:text-un1t-white">View all</Link>
        </div>
        <div className="divide-y divide-un1t-gray">
          {stats.recentLeads.map(lead => (
            <Link
              key={lead.id}
              href={`/contacts/${lead.id}`}
              className="flex items-center justify-between px-5 py-3 hover:bg-un1t-gray/30 transition-colors"
            >
              <div>
                <p className="text-sm font-medium">{lead.name}</p>
                <p className="text-xs text-un1t-light">{lead.lead_source}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                lead.lead_status === 'active_trial' ? 'bg-green-500/20 text-green-400' :
                lead.lead_status === 'member' ? 'bg-emerald-500/20 text-emerald-400' :
                lead.lead_status === 'cold' ? 'bg-gray-500/20 text-gray-400' :
                lead.lead_status === 'lost_member' ? 'bg-red-500/20 text-red-400' :
                'bg-indigo-500/20 text-indigo-400'
              }`}>
                {lead.lead_status?.replace('_', ' ')}
              </span>
            </Link>
          ))}
          {stats.recentLeads.length === 0 && (
            <p className="px-5 py-8 text-center text-un1t-light text-sm">No leads yet. They'll appear here once your n8n workflows start running.</p>
          )}
        </div>
      </div>
    </div>
  )
}
