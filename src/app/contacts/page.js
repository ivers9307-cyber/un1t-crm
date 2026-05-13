import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { MANAGER_ROLES } from '@/lib/schemas'
import ContactsView from '@/components/ContactsView'
import ContactsHeaderActions from '@/components/ContactsHeaderActions'

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
  // Active-trial chip excludes ClassPass PAYG by default — they
  // inherit lead_status='active_trial' from the contacts INSERT
  // default but aren't real trialists. Mirror this in ContactsView
  // for the client-side path. Operator can still see them via the
  // Advanced filter ('Lead Source' = 'classpass').
  if (status === 'active_trial') query = query.neq('lead_source', 'classpass')
  if (search) {
    // SEARCH.1: widened to match the API path's coverage (name +
    // email + first_name + last_name + phone, with digit-only phone
    // normalisation). Strip PostgREST .or() reserved chars from the
    // search to avoid breaking the filter syntax.
    const safe = String(search).replace(/[(),]/g, '')
    const orClauses = [
      `name.ilike.%${safe}%`,
      `email.ilike.%${safe}%`,
      `first_name.ilike.%${safe}%`,
      `last_name.ilike.%${safe}%`,
    ]
    const digits = safe.replace(/\D/g, '')
    if (digits.length >= 4) orClauses.push(`phone.ilike.%${digits}%`)
    query = query.or(orClauses.join(','))
  }

  const { data: contacts } = await query

  const canCreate = MANAGER_ROLES.includes(user.role)
  // Delete + bulk-delete: head_coach / manager / owner / master
  // (= MANAGER_ROLES). Merge stays owner+ since folding two contacts
  // into one is irreversible. CSV import is master-only — touches
  // many rows at once and is the obvious GDPR audit surface.
  const canDelete = MANAGER_ROLES.includes(user.role)
  const canMerge = user.role === 'owner' || user.role === 'master'
  const canImport = user.isMaster || user.role === 'master'

  // Load locations the master can pick from for the import wizard.
  // Skip the query for non-master callers so the page stays cheap.
  let locationsForImport = []
  if (canImport) {
    const { data } = await db.from('locations').select('id, name').eq('active', true).order('name')
    locationsForImport = data || []
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold">Contacts</h2>
        <ContactsHeaderActions
          canCreate={canCreate}
          canImport={canImport}
          locations={locationsForImport}
          defaultLocationId={locationId}
        />
      </div>
      <ContactsView
        initialContacts={contacts || []}
        locationId={locationId}
        initialStatus={status}
        initialSearch={search}
        canMerge={canMerge}
        canDelete={canDelete}
      />
    </div>
  )
}
