// /live  — convenience redirect to /live/<activeLocation>.
//
// The sidebar links here so coaches don't have to know their
// location id. We resolve the active location from the user
// session and bounce. If the user has no active location (e.g.
// master before picking one), redirect to home.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function LiveRedirectPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const activeLocationId = user.activeLocation?.id
  if (!activeLocationId) {
    // Master with no active location selected; bounce to home where
    // the location picker is.
    redirect('/')
  }
  redirect(`/live/${activeLocationId}`)
}
