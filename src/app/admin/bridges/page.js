// /admin/bridges — HR bridge registration + token management.
//
// Master-only. The studio HR bridge (champ-bridge, a Raspberry Pi)
// authenticates with a bearer token issued here. This page is the UI
// over /api/admin/bridges — register a bridge, see its live status,
// and rotate its token. It replaces the "POST the API by hand" step
// in the Pi deploy runbook.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import BridgesAdmin from './BridgesAdmin'

export const dynamic = 'force-dynamic'

export default async function BridgesAdminPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Bridge create + token rotation are master-only at the API layer;
  // gate the page to match.
  if (user.profileRole !== 'master' && user.role !== 'master') {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-subtle">HR bridge management is master-only.</p>
      </div>
    )
  }

  const db = createServerClient()
  const { data: locations } = await db
    .from('locations')
    .select('id, name')
    .eq('is_host_anchor', false)
    .order('name', { ascending: true })

  return <BridgesAdmin locations={locations || []} />
}
