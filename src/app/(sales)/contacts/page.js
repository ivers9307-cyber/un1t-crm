import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { MANAGER_ROLES } from '@/lib/schemas'
import { hasPermission } from '@/lib/permissions'
import ContactsView from '@/components/ContactsView'
import ContactsHeaderActions from '@/components/ContactsHeaderActions'
import { crossoverContactIds, fetchCrossoverContext, fetchListMembershipFlags } from '@/lib/contact-crossovers'
import { attachLinkedCounts } from '@/lib/person-links'
import ContactDuplicatesView from '@/components/ContactDuplicatesView'

export const dynamic = 'force-dynamic'

// Confidence sort order for the duplicates tab (matches the standalone page).
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 }

export default async function ContactsPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'contacts')) redirect('/')

  const db = createServerClient()
  const status = searchParams?.status || ''
  const search = searchParams?.q || ''
  const locationId = user.activeLocation?.id

  // Tab selection: ?tab=duplicates lands on the Duplicates tab.
  // Default is the contacts list. Duplicates tab requires contact_linking.
  const rawTab = searchParams?.tab
  const canSeeDuplicates = hasPermission(user, 'contact_linking')
  const tab = rawTab === 'duplicates' && canSeeDuplicates ? 'duplicates' : 'contacts'

  // ── Duplicates tab data ──────────────────────────────────────────────
  // Loaded only when the tab is active, mirroring the data-loading from
  // the former standalone /contacts/duplicates/page.js exactly.
  let suggestions = []
  if (tab === 'duplicates' && locationId) {
    // Disambiguated embed: person_link_suggestions has two FKs to contacts
    // (contact_id_a and contact_id_b). A bare `contacts(...)` embed would
    // return HTTP 300 / PGRST201. Use explicit FK hints to load each side.
    const { data: rawSuggestions } = await db
      .from('person_link_suggestions')
      .select(
        '*, contact_a:contacts!contact_id_a(id,name,email,phone,glofox_membership_status), contact_b:contacts!contact_id_b(id,name,email,phone,glofox_membership_status)'
      )
      .eq('location_id', locationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    suggestions = (rawSuggestions || []).sort((a, b) => {
      const ca = CONFIDENCE_ORDER[a.confidence] ?? 99
      const cb = CONFIDENCE_ORDER[b.confidence] ?? 99
      if (ca !== cb) return ca - cb
      return a.created_at < b.created_at ? -1 : 1
    })
  }

  // ── Contacts list data ───────────────────────────────────────────────
  // Initial server-rendered list — covers the no-advanced-filter case
  // (zero client round-trips for the common load). When the operator
  // adds an advanced filter row, ContactsView swaps to /api/contacts/search.
  //
  // PERF.2 — narrowed from select('*') to the explicit field set
  // ContactsTable + ContactsView actually consume. Cuts the wire size
  // ~70% for the no-filter load and speeds up the JSON parse on the
  // client. If a downstream component needs more columns, add them
  // here AND in the /api/contacts/search route so both paths return
  // the same shape.
  // person_group_id drives the "Linked" chip; is_primary_contact (mig 334)
  // folds a linked person down to ONE row (the group primary) in this lookup
  // list. The non-primary accounts stay reachable from the profile + via the
  // "Show linked duplicates" toggle (which re-queries the API without it).
  const CONTACT_LIST_FIELDS = 'id, name, email, phone, lead_source, pipeline_stage_slug, trial_credits_remaining, created_at, location_id, glofox_membership_status, person_group_id'
  const crossIds = await crossoverContactIds(db, locationId)
  let query = db.from('contacts').select(CONTACT_LIST_FIELDS).eq('is_primary_contact', true)
  query = crossIds.length > 0
    ? query.or(`location_id.eq.${locationId},id.in.(${crossIds.join(',')})`)
    : query.eq('location_id', locationId)
  query = query.order('created_at', { ascending: false }).limit(200)
  if (status) query = query.eq('pipeline_stage_slug', status)
  // FUNNEL.1 — the old active_trial chip's ClassPass carve-out is
  // gone: ClassPass PAYG contacts classify into their own 'classpass'
  // stage now, so no lead_source exclusion is needed.
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

  const { data: rawContacts } = await query
  const contacts = await attachLinkedCounts(db, rawContacts || [])
  const crossoverContext = await fetchCrossoverContext(db, contacts, locationId)
  // LISTFLAG.1 — preference-row membership at OTHER studios. Must be fed to
  // ContactsView alongside the crossover context AND returned by
  // /api/contacts/search, or the pills vanish the moment the operator types.
  const listFlags = await fetchListMembershipFlags(db, contacts, locationId)

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
    const { data } = await db.from('locations').select('id, name').eq('active', true).eq('is_host_anchor', false).order('name')
    locationsForImport = data || []
  }

  // Tab definitions. Duplicates tab only shown to users with contact_linking.
  const tabs = [
    { id: 'contacts',   label: 'Contacts',   href: '/contacts' },
    ...(canSeeDuplicates
      ? [{ id: 'duplicates', label: 'Duplicates', href: '/contacts?tab=duplicates' }]
      : []),
  ]

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold">Contacts</h2>
        {tab === 'contacts' && (
          <ContactsHeaderActions
            canCreate={canCreate}
            canImport={canImport}
            locations={locationsForImport}
            defaultLocationId={locationId}
          />
        )}
      </div>

      {/* Tab strip — server-rendered via ?tab= search param so the page
          stays a pure server component. Clicking a tab does a full
          navigation; data for the active tab is loaded server-side. */}
      {tabs.length > 1 && (
        <div className="flex items-center gap-1 mb-5 border-b border-un1t-border">
          {tabs.map((t) => {
            const active = tab === t.id
            return (
              <Link
                key={t.id}
                href={t.href}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-un1t-text text-un1t-text font-medium'
                    : 'border-transparent text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </div>
      )}

      {tab === 'contacts' && (
        <ContactsView
          initialContacts={contacts || []}
          locationId={locationId}
          crossoverContext={crossoverContext}
          listFlags={listFlags}
          initialStatus={status}
          initialSearch={search}
          canMerge={canMerge}
          canDelete={canDelete}
        />
      )}

      {tab === 'duplicates' && (
        <div className="max-w-4xl">
          <ContactDuplicatesView suggestions={suggestions} locationId={locationId} />
        </div>
      )}
    </div>
  )
}
