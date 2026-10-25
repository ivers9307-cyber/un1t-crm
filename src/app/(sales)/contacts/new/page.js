// /contacts/new — manager+ create form. Reuses ContactForm with no
// `contact` prop. Active location is filled in server-side by
// /api/contacts on POST.
//
// ROLEUI.1 — the gate is the POST's own decision (canWriteContact: a member
// holding MANAGER_ROLES there) asked of the location the POST creates at: the
// ACTIVE studio, named explicitly rather than read through user.role.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { canWriteContact } from '@/lib/contact-page-gates'
import ContactForm from '@/components/ContactForm'

export const dynamic = 'force-dynamic'

export default async function NewContactPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const createAt = user.activeLocation?.id || null
  if (!canWriteContact(user, createAt)) redirect('/contacts')
  if (!hasPermissionForLocation(user, createAt, 'contacts')) redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">New contact</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Created at {user.activeLocation?.name || 'your active location'}.
      </p>
      <ContactForm />
    </div>
  )
}
