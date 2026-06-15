// /contacts/duplicates — Duplicate contact review queue
//
// Server page (RSC). Loads pending person_link_suggestions for the active
// location ordered by confidence (high → medium → low) then created_at.
// Uses the disambiguated FK embed to avoid the PGRST201 "more than one
// relationship" error (person_link_suggestions has TWO FKs to contacts).
//
// PERSON-LINK.2 — review queue page.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import ContactDuplicatesView from '@/components/ContactDuplicatesView'

export const dynamic = 'force-dynamic'

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 }

export default async function ContactDuplicatesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'contact_linking')) redirect('/contacts')

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/contacts')

  const db = createServerClient()

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

  const suggestions = (rawSuggestions || []).sort((a, b) => {
    const ca = CONFIDENCE_ORDER[a.confidence] ?? 99
    const cb = CONFIDENCE_ORDER[b.confidence] ?? 99
    if (ca !== cb) return ca - cb
    return a.created_at < b.created_at ? -1 : 1
  })

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <ContactDuplicatesView suggestions={suggestions} locationId={locationId} />
    </div>
  )
}
