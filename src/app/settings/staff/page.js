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
import { ChevronLeft, Users } from 'lucide-react'
import StaffSearchableList from '@/components/settings/StaffSearchableList'

export const dynamic = 'force-dynamic'

export default async function StaffIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  const { data: staffRows } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .order('created_at')
  const staff = staffRows || []

  // Pre-compute the canEdit boolean per row server-side so the client
  // component doesn't need to know about the master/owner peer rules.
  const canEditFns = Object.fromEntries(
    staff.map(s => [
      s.id,
      canEditStaffMember(
        { id: user.id, role: user.role, isMaster: user.isMaster },
        { id: s.id, role: s.role },
      ),
    ])
  )

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-3"
      >
        <ChevronLeft size={14} /> Settings
      </Link>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold inline-flex items-center gap-2">
            <Users size={20} className="text-un1t-light" /> Team Members
          </h2>
          <p className="text-sm text-un1t-light mt-1">
            {staff.length} {staff.length === 1 ? 'member' : 'members'} across all locations.
          </p>
        </div>
        <Link
          href="/settings/staff/new"
          className="text-sm bg-un1t-white text-un1t-black px-4 py-2 rounded-md hover:bg-un1t-accent transition-colors font-medium"
        >
          Add Staff
        </Link>
      </div>

      <StaffSearchableList staff={staff} user={user} canEditFns={canEditFns} />
    </div>
  )
}
