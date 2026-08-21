// /team — Team hub index. Mirrors /money (HUBS.2c) with one difference:
// the chain never dead-ends at '/' — /policies is open to every signed-in
// user (its page gate is login-only), so Policies is the universal
// fallback. That is also why the sidebar entry is `openToAll` and has no
// permission union to satisfy.
//
// HUBDOOR.1 — the chain moved to src/lib/hub-index-chains.js as data,
// alongside every other hub's, so the union-reaches-a-surface invariant
// has one place to be asserted from.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function TeamIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/team', hasPermission))
}
