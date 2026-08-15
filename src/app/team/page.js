// /team — Team hub index. Mirrors /money (HUBS.2c) with one difference:
// the chain never dead-ends at '/' — /policies is open to every signed-in
// user (its page gate is login-only), so Policies is the universal
// fallback.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function TeamIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'schedule')) redirect('/schedule')
  if (hasPermission(user, 'contracts')) redirect('/contracts')
  redirect('/policies')
}
