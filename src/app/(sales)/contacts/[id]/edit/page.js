// /contacts/[id]/edit — manager+ edit form. Pre-populates the
// shared ContactForm with the existing row.
//
// ROLEUI.1 — every gate is judged at the CONTACT's location, the location the
// form's PUT /api/contacts/[id] acts on (MANAGER_ROLES there, since
// ROLESWEEP.1c/.2). It used to read user.role and hasPermission(user, …),
// both the ACTIVE studio's, so it opened a form the PUT would refuse and
// refused one the PUT would take. The contact page's Edit link asks the same
// question (canOpenContactEditor), so the link and the page agree.

import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { canWriteContact } from '@/lib/contact-page-gates'
import ContactForm from '@/components/ContactForm'

export const dynamic = 'force-dynamic'

export default async function EditContactPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: contact } = await db
    .from('contacts')
    .select('*')
    .eq('id', params.id)
    .single()
  if (!contact) notFound()

  // Location ownership check — staff at a different location
  // shouldn't be able to edit this contact even if they guess the URL.
  if (!user.isMaster) {
    const userLocIds = (user.locations || []).map(l => l.id)
    if (!userLocIds.includes(contact.location_id)) redirect('/contacts')
  }
  // The role the PUT requires, at the contact's location.
  if (!canWriteContact(user, contact.location_id)) redirect(`/contacts/${contact.id}`)
  // The page's own feature gate, at the same location.
  if (!hasPermissionForLocation(user, contact.location_id, 'contacts')) redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit contact</h2>
      <p className="text-sm text-un1t-subtle mb-6">{contact.name}</p>
      <ContactForm contact={contact} onCancelHref={`/contacts/${contact.id}`} />
    </div>
  )
}
