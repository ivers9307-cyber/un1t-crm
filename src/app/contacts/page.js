import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ContactsTable from '@/components/ContactsTable'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function ContactsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const status = searchParams?.status || ''
  const search = searchParams?.q || ''
  const locationId = user.activeLocation?.id

  let query = db.from('contacts').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
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

      {/* Table — client component handles row selection + bulk action bar. */}
      <ContactsTable contacts={contacts || []} locationId={locationId} />
    </div>
  )
}
