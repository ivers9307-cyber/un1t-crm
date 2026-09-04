// /settings/staff — team-members index page with search.
//
// SETTINGS.4 split this out of the inline table on /settings so the
// settings page stops being dominated by a 50-row roster table.
// Search + status filter happen client-side via StaffSearchableList.
// Server fetches the full list (today small enough that pagination
// isn't worth the complexity).

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { canEditStaffMember } from '@/lib/staff-access'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users } from 'lucide-react'
import StaffSearchableList from '@/components/settings/StaffSearchableList'
import { deriveTargetVersion, deviceVerdict, currentDevice } from '@/lib/staff-devices'

export const dynamic = 'force-dynamic'

export default async function StaffIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  // STAFF-DEV.5 — devices ride along with the roster so the list can show
  // who is behind. Both sets are staff-sized; one round-trip each.
  const [staffRes, devicesRes] = await Promise.all([
    db.from('profiles').select('*, profile_locations(*, locations(*))').order('created_at'),
    db.from('device_tokens').select('id, user_id, app_version, last_seen_at, geofence_permission'),
  ])
  const staff = staffRes.data || []
  const devices = devicesRes.data || []

  // Verdicts computed server-side (one clock, shared lib) so the client
  // component renders a decision rather than making one. The target comes
  // from ACTIVE staff's devices only — a leaver's newer phone must not
  // mark everyone still here as outdated.
  const now = Date.now()
  const devicesByUser = new Map()
  for (const d of devices) {
    if (!d.user_id) continue
    if (!devicesByUser.has(d.user_id)) devicesByUser.set(d.user_id, [])
    devicesByUser.get(d.user_id).push(d)
  }
  const activeIds = new Set(staff.filter(s => s.active).map(s => s.id))
  const targetVersion = deriveTargetVersion(devices.filter(d => activeIds.has(d.user_id)), now)
  const verdictsById = Object.fromEntries(
    staff.map(s => [s.id, deviceVerdict(devicesByUser.get(s.id) || [], targetVersion, now)]),
  )
  // Background-location state for the CURRENT device only — an old iPad
  // that once granted "always" says nothing about today's phone. NULL
  // means never reported and renders as "—", never as "denied".
  const permissionsById = Object.fromEntries(
    staff.map(s => [s.id, currentDevice(devicesByUser.get(s.id) || [])?.geofence_permission ?? null]),
  )

  // Pre-compute the canEdit boolean per row server-side so the client
  // component doesn't need to know about the master/owner peer rules.
  const canEditFns = Object.fromEntries(
    staff.map(s => [
      s.id,
      canEditStaffMember(
        { id: user.id, role: user.role, isMaster: user.isMaster, rolesByLocation: user.rolesByLocation },
        // STAFF-EDIT-RULE.1 — the rule needs the target's locations: an
        // owner may only edit staff at a studio THEY own.
        { id: s.id, role: s.role, locationIds: (s.profile_locations || []).map(l => l.location_id) },
      ),
    ])
  )

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold inline-flex items-center gap-2">
            <Users size={20} className="text-un1t-subtle" /> Team Members
          </h2>
          <p className="text-sm text-un1t-subtle mt-1">
            {staff.length} {staff.length === 1 ? 'member' : 'members'} across all locations.
          </p>
        </div>
        <Link
          href="/settings/staff/new"
          className="text-sm bg-un1t-text text-un1t-bg px-4 py-2 rounded-md hover:bg-un1t-accent transition-colors font-medium"
        >
          Add Staff
        </Link>
      </div>

      <StaffSearchableList
        staff={staff}
        user={user}
        canEditFns={canEditFns}
        verdictsById={verdictsById}
        permissionsById={permissionsById}
        targetVersion={targetVersion}
      />
    </div>
  )
}
