import { headers } from 'next/headers'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import AppShell from './AppShell'

export default async function AppShellServer({ children }) {
  const user = await getCurrentUser()
  // HOST-PORTAL.5 — a linked staff-host holds BOTH a profiles row (staff) and
  // a host_users row (host access to a host in their org, via the admin
  // link-staff action). Resolve it once here so the CRM sidebar can offer a
  // "Host portal" jump-link for that one login. A single lookup by auth id.
  let isLinkedHost = false
  if (user?.id) {
    const db = createServerClient()
    const { data } = await db.from('host_users').select('auth_user_id').eq('auth_user_id', user.id).maybeSingle()
    isLinkedHost = !!data
  }
  // PAGES.1 — the proxy stamps x-public-page: 1 on a request it admitted as a
  // landing_pages row (and deletes any copy a client sent), so the client shell
  // renders that page bare instead of bouncing the visitor to /login.
  const isPublicPage = (await headers()).get('x-public-page') === '1'
  return <AppShell user={user} isLinkedHost={isLinkedHost} isPublicPage={isPublicPage}>{children}</AppShell>
}
