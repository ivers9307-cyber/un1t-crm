import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const statusBadge = {
  active_trial:  'bg-green-500/20 text-green-400',
  member:        'bg-emerald-500/20 text-emerald-400',
  cold:          'bg-gray-500/20 text-gray-400',
  lost_member:   'bg-red-500/20 text-red-400',
  returning:     'bg-indigo-500/20 text-indigo-400',
}

export default async function ContactsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const status = searchParams?.status || ''
  const search = searchParams?.q || ''

  let query = db.from('contacts').select('*').eq('location_id', user.activeLocation?.id).order('created_at', { ascending: false }).limit(100)
  if (status) query = query.eq('lead_status', status)
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)

  const { data: contacts } = await query

  const statuses = ['', 'active_trial', 'member', 'cold', 'lost_member', 'returning']

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-5">Contacts</h2>

      {/* Filters */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {statuses.map(s => (
          <Link
            key={s}
            href={`/contacts${s ? `?status=${s}` : ''}`}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              status === s
                ? 'border-un1t-white text-un1t-white bg-un1t-gray'
                : 'border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
            }`}
          >
            {s ? s.replace('_', ' ') : 'All'}
          </Link>
        ))}
      </div>

      {/* Search */}
      <form className="mb-5">
        <input
          type="text"
          name="q"
          defaultValue={search}
          placeholder="Search by name or email..."
          className="w-full max-w-md bg-un1t-dark border border-un1t-gray rounded-md px-4 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
        />
      </form>

      {/* Table */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-un1t-gray text-un1t-light text-xs uppercase tracking-wider">
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Phone</th>
              <th className="text-left p-3">Source</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Credits</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-gray">
            {(contacts || []).map(c => (
              <tr key={c.id} className="hover:bg-un1t-gray/20 transition-colors">
                <td className="p-3">
                  <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                </td>
                <td className="p-3 text-un1t-light">{c.email}</td>
                <td className="p-3 text-un1t-light">{c.phone}</td>
                <td className="p-3">
                  <span className="text-xs px-1.5 py-0.5 bg-un1t-gray rounded">{c.lead_source || '—'}</span>
                </td>
                <td className="p-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge[c.lead_status] || 'bg-un1t-gray text-un1t-light'}`}>
                    {c.lead_status?.replace('_', ' ') || '—'}
                  </span>
                </td>
                <td className="p-3 text-un1t-light">{c.trial_credits_remaining ?? '—'}</td>
                <td className="p-3">
                  <Link href={`/contacts/${c.id}`}>
                    <ChevronRight size={16} className="text-un1t-mid" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!contacts || contacts.length === 0) && (
          <p className="text-center text-un1t-light text-sm py-12">No contacts found.</p>
        )}
      </div>
    </div>
  )
}
