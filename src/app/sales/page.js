// /sales — Sales hub index. The sidebar's single Sales entry points here;
// the hub's real surfaces keep their existing URLs (/pipeline, /contacts,
// /activities — phase-2 amended URL strategy: hub chrome over existing
// URLs, no page moves). Redirect to the first tab this user can see.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function SalesIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'pipeline')) redirect('/pipeline')
  if (hasPermission(user, 'contacts')) redirect('/contacts')
  if (hasPermission(user, 'activities')) redirect('/activities')
  redirect('/')
}
