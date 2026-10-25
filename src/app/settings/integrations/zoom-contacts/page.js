// INTEGONE.3 — the Zoom phone directory is the Integrations hub's Zoom view.
// This URL stays so every bookmark and old link lands there. A signed-out
// caller still goes to /login first.
//
// Gate note: the old page admitted any signed-in user and rendered an
// org-scoped empty shell for non-members; the hub is owner+/master. The
// Settings tree already hid the row from everyone else, so this is accepted.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hubViewHref } from '@/lib/integrations-hub-links'

export const dynamic = 'force-dynamic'

export default async function ZoomContactsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(hubViewHref('zoom'))
}
