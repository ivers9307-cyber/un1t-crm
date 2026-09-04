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

  // The locations this caller is OWNER at — the page's own definition of
  // what an owner may administer (it already used this below to decide
  // which cards StaffForm may edit). Derived from rolesByLocation, so no
  // query. Master is unrestricted and skips all of this.
  const ownedByCaller = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)

  const db = createServerClient()

  // 🔴 SECURITY — WHOSE record is this? The role gate above says the caller
  // is an owner SOMEWHERE; it says nothing about whether this PROFILE is
  // theirs to see. Every read below uses the service-role client, which
  // bypasses RLS, so nothing else scoped them: any owner-role user could
  // open /settings/staff/<any profile id> and receive that person's full
  // profiles row plus EVERY profile_locations assignment — including staff
  // in another organisation (UN1T Group vs CCF Autos). Personal data, so
  // the check runs BEFORE the profile is read, not after: a refused caller
  // reads location ids and nothing about the person.
  //
  // The rule: the target must work somewhere this caller OWNS. Sharing a
  // location is not enough — an owner may only administer their own
  // studios, so a record they could not edit is a record they should not
  // read either.
  //
  // Deliberately NOT narrowing the profile read itself to those locations
  // (the obvious alternative): the `*, profile_locations(*)` select below
  // is load-bearing, and its own comment records TWICE that a narrowed
  // list silently dropped a column and the form then saved defaults back
  // over the operator's real values. A filtered read would hide
  // assignments the form still POSTs, which is that bug with a security
  // rationale attached. Pre-check, then read whole.
  //
  // 404, not 403, so profile ids cannot be enumerated.
  if (!user.isMaster) {
    if (ownedByCaller.length === 0) notFound()
    const { data: targetLocs, error: targetLocsErr } = await db
      .from('profile_locations')
      .select('location_id')
      .eq('profile_id', params.id)
    // An unreadable answer is not permission. A blip costs an owner a
    // retry; guessing costs somebody else's record.
    if (targetLocsErr) notFound()
    const targetLocationIds = (targetLocs || []).map(r => r.location_id)
    // STAFF-EDIT-RULE.1 corrects #1592's sibling: a profile assigned
    // NOWHERE used to be opened by any owner here, on the reasoning that
    // it belongs to no studio. But assertOwnerAssignmentScope
    // (staff-write.js) has always REFUSED an owner's PUT when there is no
    // overlap — zero assignments included — so that leniency only offered
    // a form the server rejects. The page now matches the boundary. A
    // master can still reach an unassigned profile and give it a home.
    if (!targetLocationIds.some(id => ownedByCaller.includes(id))) notFound()
  }

  const [profileRes, locationsRes, templatesRes, orgsRes, orgGrantsRes] = await Promise.all([
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
    db.from('locations').select('*').eq('active', true).eq('is_host_anchor', false).order('name'),
    // PERM-AUDIT.3 — role templates (mig 364) so the form hydrates
    // toggles against the role's EFFECTIVE defaults at each location.
    db.from('location_role_permissions').select('location_id, role, employment_type, permissions'),
    // SAAS-4 (mig 417) — org list + current org-admin grants for the
    // master-only Organisation Admin card. Owners never see the card,
    // so both fetches are skipped for them.
    user.isMaster
      ? db.from('organizations').select('id, name, slug').eq('active', true).order('name')
      : Promise.resolve({ data: null }),
    user.isMaster
      ? db.from('profile_organizations').select('organization_id').eq('profile_id', params.id)
      : Promise.resolve({ data: null }),
  ])

  if (!profileRes.data) notFound()

  // Owner-self / owner-peer guard. Master is exempt. The check has
  // a server-side equivalent in /api/staff/[id]'s PUT handler — this
  // is the UI gate that prevents the form from rendering at all,
  // not just a button hide.
  if (!canEditStaffMember(
    { id: user.id, role: user.role, isMaster: user.isMaster, rolesByLocation: user.rolesByLocation },
    {
      id: profileRes.data.id,
      role: profileRes.data.role,
      // STAFF-EDIT-RULE.1 — the helper judges ownership at the target's
      // locations now, so it needs them.
      locationIds: (profileRes.data.profile_locations || []).map(l => l.location_id),
    },
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
    : ownedByCaller

  const staff = {
    ...profileRes.data,
    is_master: profileRes.data.role === 'master',
    assignments,
  }

  // { [location_id]: { [role]: { [employment_type]: sparse blob } } }
  // (RECEPTION.2, mig 367 — StaffForm merges 'all' + the form's
  // current employment type live, so flipping FTE↔Contractor
  // re-baselines the permission toggles.)
  const roleTemplates = {}
  for (const row of (templatesRes.data || [])) {
    roleTemplates[row.location_id] = roleTemplates[row.location_id] || {}
    roleTemplates[row.location_id][row.role] = roleTemplates[row.location_id][row.role] || {}
    roleTemplates[row.location_id][row.role][row.employment_type || 'all'] = row.permissions || {}
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
        roleTemplates={roleTemplates}
        organizations={orgsRes?.data || []}
        orgAdminOrgIds={(orgGrantsRes?.data || []).map(g => g.organization_id)}
      />
    </div>
  )
}
