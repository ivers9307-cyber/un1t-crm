// /contacts/new — manager+ create form. Reuses ContactForm with no
// `contact` prop. Active location is filled in server-side by
// /api/contacts on POST.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import ContactForm from '@/components/ContactForm'

export const dynamic = 'force-dynamic'

export default async function NewContactPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/contacts')
  if (!hasPermission(user, 'contacts')) redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">New contact</h2>
      <p className="text-sm text-un1t-light mb-6">
        Created at {user.activeLocation?.name || 'your active location'}.
      </p>
      <ContactForm />
    </div>
  )
}
