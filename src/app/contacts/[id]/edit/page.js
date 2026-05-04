// /contacts/[id]/edit — manager+ edit form. Pre-populates the
// shared ContactForm with the existing row.

import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import ContactForm from '@/components/ContactForm'

export const dynamic = 'force-dynamic'

export default async function EditContactPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect(`/contacts/${params.id}`)
  if (!hasPermission(user, 'contacts')) redirect('/')

  const db = createServerClient()
  const { data: contact } = await db
    .from('contacts')
    .select('*')
    .eq('id', params.id)
    .single()
  if (!contact) notFound()

  // Location ownership check — staff at a different location
  // shouldn't be able to edit this contact even if they guess the URL.
  if (user.role !== 'master') {
    const userLocIds = (user.locations || []).map(l => l.id)
    if (!userLocIds.includes(contact.location_id)) redirect('/contacts')
  }

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit contact</h2>
      <p className="text-sm text-un1t-light mb-6">{contact.name}</p>
      <ContactForm contact={contact} onCancelHref={`/contacts/${contact.id}`} />
    </div>
  )
}
