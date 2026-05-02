import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import StaffForm from '@/components/StaffForm'

export const dynamic = 'force-dynamic'

export default async function EditStaffPage({ params }) {
  const user = await getCurrentUser()
  if (!user || (!user.isMaster && user.role !== 'owner')) redirect('/')

  const db = createServerClient()
  const [profileRes, locationsRes] = await Promise.all([
    db.from('profiles')
      .select('*, profile_locations(location_id, role, unifi_door_access, unifi_user_id, is_default)')
      .eq('id', params.id)
      .single(),
    db.from('locations').select('*').eq('active', true).order('name'),
  ])

  if (!profileRes.data) notFound()

  // Per mig 051 — assemble the assignments array the form will edit.
  // One row per profile_locations entry, carrying its own role + UniFi
  // toggle + default flag. The form mutates this array in place.
  const assignments = (profileRes.data.profile_locations || []).map(pl => ({
    location_id: pl.location_id,
    role: pl.role,
    is_default: !!pl.is_default,
    unifi_door_access: !!pl.unifi_door_access,
  }))

  // Caller scope: master sees every location; owner sees only the
  // locations they themselves are owner at. Used to gate which cards
  // the form can add/remove/edit.
  const callerOwnerLocationIds = user.isMaster
    ? (locationsRes.data || []).map(l => l.id)
    : Object.entries(user.rolesByLocation || {})
        .filter(([, r]) => r === 'owner')
        .map(([loc]) => loc)

  const staff = {
    ...profileRes.data,
    is_master: profileRes.data.role === 'master',
    assignments,
  }

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit Team Member</h2>
      <p className="text-sm text-un1t-light mb-6">Update role, permissions, and access</p>
      <StaffForm
        staff={staff}
        locations={locationsRes.data || []}
        callerIsMaster={!!user.isMaster}
        callerOwnerLocationIds={callerOwnerLocationIds}
      />
    </div>
  )
}
