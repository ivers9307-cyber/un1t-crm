// /sales — Sales hub index. The sidebar's single Sales entry points here;
// the hub's real surfaces keep their existing URLs (/pipeline, /contacts,
// /activities — phase-2 amended URL strategy: hub chrome over existing
// URLs, no page moves). Redirect to the first tab this user can see.
//
// HUBDOOR.1 — the chain moved to src/lib/hub-index-chains.js as data so
// nav-items.test.js can prove every key in this hub's sidebar union
// reaches a real surface (Sales was already complete; the module is what
// keeps it that way).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function SalesIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/sales', hasPermission))
}
