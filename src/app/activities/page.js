import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Phone, Mail, Calendar, CheckSquare, Clock, User } from 'lucide-react'
import ActivityToggle from '@/components/ActivityToggle'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const typeIcons = { call: Phone, email: Mail, meeting: Calendar, task: CheckSquare }

export default async function ActivitiesPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const filter = searchParams?.filter || 'upcoming'

  let query = db.from('activities')
    .select('*, contacts(id, name)')
    .eq('location_id', user.activeLocation?.id)
    .order('due_date', { ascending: true })
    .limit(100)

  if (filter === 'upcoming') query = query.eq('done', false)
  else if (filter === 'overdue') query = query.eq('done', false).lt('due_date', new Date().toISOString().split('T')[0])
  else if (filter === 'done') query = query.eq('done', true)

  const { data: activities } = await query

  const filters = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'done', label: 'Done' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-5">Activities</h2>

      <div className="flex gap-2 mb-5">
        {filters.map(f => (
          <Link
            key={f.key}
            href={`/activities?filter=${f.key}`}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              filter === f.key
                ? 'border-white text-white bg-un1t-gray'
                : 'border-un1t-gray text-un1t-light hover:text-white hover:border-un1t-mid'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
        {(!activities || activities.length === 0) && (
          <p className="text-sm text-un1t-mid text-center py-12">No activities found.</p>
        )}
        {(activities || []).map(a => {
          const Icon = typeIcons[a.type] || CheckSquare
          const isOverdue = !a.done && a.due_date && new Date(a.due_date) < new Date(new Date().toDateString())

          return (
            <div key={a.id} className={`flex items-start gap-3 p-4 ${a.done ? 'opacity-50' : ''}`}>
              <ActivityToggle activityId={a.id} done={a.done} />
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                a.type === 'call' ? 'bg-blue-500/20' :
                a.type === 'email' ? 'bg-purple-500/20' :
                a.type === 'meeting' ? 'bg-green-500/20' :
                'bg-yellow-500/20'
              }`}>
                <Icon size={14} className={
                  a.type === 'call' ? 'text-blue-400' :
                  a.type === 'email' ? 'text-purple-400' :
                  a.type === 'meeting' ? 'text-green-400' :
                  'text-yellow-400'
                } />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${a.done ? 'line-through' : ''}`}>{a.subject}</p>
                {a.contacts?.name && (
                  <Link href={`/contacts/${a.contacts.id}`} className="text-xs text-un1t-light hover:text-white flex items-center gap-1 mt-0.5">
                    <User size={10} /> {a.contacts.name}
                  </Link>
                )}
                {a.note && <p className="text-xs text-un1t-mid mt-1">{a.note}</p>}
              </div>
              <div className="text-right shrink-0">
                {a.due_date && (
                  <p className={`text-xs flex items-center gap-1 ${isOverdue ? 'text-red-400' : 'text-un1t-light'}`}>
                    <Clock size={10} /> {a.due_date} {a.due_time || ''}
                  </p>
                )}
                <span className="text-[10px] text-un1t-mid uppercase">{a.type}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
