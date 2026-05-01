import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import StaffForm from '@/components/StaffForm'

export const dynamic = 'force-dynamic'

export default async function EditStaffPage({ params }) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'master' && user.role !== 'owner')) redirect('/')

  const db = createServerClient()
  const [profileRes, locationsRes] = await Promise.all([
    db.from('profiles')
      .select('*, profile_locations(location_id, unifi_door_access, unifi_user_id, is_default)')
      .eq('id', params.id)
      .single(),
    db.from('locations').select('*').eq('active', true).order('name'),
  ])

  if (!profileRes.data) notFound()

  // Build a per-location door-access map keyed by location_id so the
  // form can render one toggle per assigned location. Maintained
  // server-side via migration 024 on the profile_locations rows.
  const doorAccessByLocation = {}
  for (const pl of profileRes.data.profile_locations || []) {
    doorAccessByLocation[pl.location_id] = !!pl.unifi_door_access
  }

  const staff = {
    ...profileRes.data,
    location_ids: (profileRes.data.profile_locations || []).map(pl => pl.location_id),
    door_access_by_location: doorAccessByLocation,
  }

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit Team Member</h2>
      <p className="text-sm text-un1t-light mb-6">Update role, permissions, and access</p>
      <StaffForm staff={staff} locations={locationsRes.data || []} callerRole={user.role} />
    </div>
  )
}
