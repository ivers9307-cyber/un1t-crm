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
    // CRITICAL: select profile_locations(*) — EVERY column — so
    // mapProfileLocationToAssignment() always receives the full row.
    // History: a narrowed explicit column list silently dropped a
    // per-assignment column TWICE — first `permissions` (mig 092),
    // then `ac_device_ids` (STUDIO-AC-DEVICES.3, which added the column
    // to the schema, PUT route AND the mapper but missed THIS hand-
    // written list). Each time the form loaded empty/role-default
    // values and on save POSTed them BACK over the operator's real
    // selection, so the saved override looked wiped on refresh. `*`
    // makes the mapper the single source of shape truth, so adding a
    // future per-assignment column can never silently drop here again.
    // (Service-role client — no RLS column concerns.)
    db.from('profiles')
      .select('*, profile_locations(*)')
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
