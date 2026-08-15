// /live  — convenience redirect to /live/<activeLocation>.
//
// The sidebar links here so coaches don't have to know their
// location id. We resolve the active location from the user
// session and bounce. If the user has no active location (e.g.
// master before picking one), redirect to home.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function LiveRedirectPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // SEC-LIVE-GATE.1 — the sidebar nav and /members hub index both gate
  // this on `studio_management` ("Same permission gate as Studio
  // Management"), but nothing enforced it server-side. Same gate as
  // src/app/(operations)/studio-management/page.js.
  if (!hasPermission(user, 'studio_management')) redirect('/')
  const activeLocationId = user.activeLocation?.id
  if (!activeLocationId) {
    // Master with no active location selected; bounce to home where
    // the location picker is.
    redirect('/')
  }
  redirect(`/live/${activeLocationId}`)
}
