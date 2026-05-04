import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import ContactsView from '@/components/ContactsView'

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

  // Initial server-rendered list — covers the no-advanced-filter case
  // (zero client round-trips for the common load). When the operator
  // adds an advanced filter row, ContactsView swaps to /api/contacts/search.
  let query = db.from('contacts').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(200)
  if (status) query = query.eq('lead_status', status)
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)

  const { data: contacts } = await query

  const canCreate = MANAGER_ROLES.includes(user.role)
  const canMerge = user.role === 'owner' || user.role === 'master'

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold">Contacts</h2>
        {canCreate && (
          <Link
            href="/contacts/new"
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} /> New contact
          </Link>
        )}
      </div>
      <ContactsView
        initialContacts={contacts || []}
        locationId={locationId}
        initialStatus={status}
        initialSearch={search}
        canMerge={canMerge}
      />
    </div>
  )
}
