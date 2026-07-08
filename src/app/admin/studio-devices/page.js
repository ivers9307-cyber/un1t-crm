// STUDIO-PIN.2 — /admin/studio-devices
//
// Master-only admin page for managing studio-device PIN auth:
//   - paired devices (Mac shells + iPads)
//   - trusted IP CIDRs per location
//
// The page is a thin server wrapper around the StudioDevicesManager
// client component, which does all the data fetching + mutations
// against the /api/admin/* endpoints in this PR.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import StudioDevicesManager from '@/components/admin/StudioDevicesManager'

export const dynamic = 'force-dynamic'

export default async function StudioDevicesPage() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') {
    redirect('/')
  }

  // Locations list for the device-pair + IP-add forms. Master sees
  // every location.
  const db = createServerClient()
  const { data: locations } = await db
    .from('locations')
    .select('id, name')
    .eq('is_host_anchor', false)
    .order('name', { ascending: true })

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      <h2 className="text-2xl font-bold mb-1">Studio devices</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Manage Mac shells and iPads that are paired with studio locations
        for PIN-based staff login. Add the studio&apos;s public IP(s) here
        first, then pair each device from this page and paste the
        one-time pairing token into the device&apos;s pairing screen.
      </p>
      <StudioDevicesManager locations={locations || []} />
    </div>
  )
}
