import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import StaffForm from '@/components/StaffForm'
import { canEditStaffMember, mapProfileLocationToAssignment } from '@/lib/staff-access'

export const dynamic = 'force-dynamic'

export default async function EditStaffPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || (!user.isMaster && user.role !== 'owner')) redirect('/')

  const db = createServerClient()
  const [profileRes, locationsRes] = await Promise.all([
    // CRITICAL: include permissions on profile_locations. Bug fix —
    // the previous SELECT narrowed to (location_id, role,
    // unifi_door_access, unifi_user_id, is_default), silently
    // dropping the permissions JSONB. The form fell back to role
    // defaults, then on save POSTed the role-default values BACK to
    // the row — making every per-user override look like it was
    // wiped on refresh. mapProfileLocationToAssignment() now
    // centralises the shape so a future SELECT change can't recur
    // the same bug without breaking the helper's contract test.
    db.from('profiles')
      .select('*, profile_locations(location_id, role, unifi_door_access, unifi_user_id, unifi_door_ids, protect_face_id, is_default, permissions)')
      .eq('id', params.id)
      .single(),
    db.from('locations').select('*').eq('active', true).order('name'),
  ])

  if (!profileRes.data) notFound()

  // Owner-self / owner-peer guard. Master is exempt. The check has
  // a server-side equivalent in /api/staff/[id]'s PUT handler — this
  // is the UI gate that prevents the form from rendering at all,
  // not just a button hide.
  if (!canEditStaffMember(
    { id: user.id, role: user.role, isMaster: user.isMaster },
    { id: profileRes.data.id, role: profileRes.data.role },
  )) {
    redirect('/settings')
  }

  const assignments = (profileRes.data.profile_locations || [])
    .map(mapProfileLocationToAssignment)
    .filter(Boolean)

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
      <p className="text-sm text-un1t-subtle mb-6">Update role, permissions, and access</p>
      <StaffForm
        staff={staff}
        locations={locationsRes.data || []}
        callerIsMaster={!!user.isMaster}
        callerOwnerLocationIds={callerOwnerLocationIds}
      />
    </div>
  )
}
