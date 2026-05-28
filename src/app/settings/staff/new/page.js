import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import StaffForm from '@/components/StaffForm'

export const dynamic = 'force-dynamic'

export default async function NewStaffPage() {
  const user = await getCurrentUser()
  // Master OR owner-at-active-location can create staff. The
  // assignments wizard inside StaffForm further restricts WHICH
  // locations a non-master caller can grant access to.
  if (!user || (!user.isMaster && user.role !== 'owner')) redirect('/')

  const db = createServerClient()
  const { data: locations } = await db.from('locations').select('*').eq('active', true).order('name')

  // Per mig 051 — locations the caller is owner at, derived from the
  // resolved rolesByLocation map. Master gets every location.
  const callerOwnerLocationIds = user.isMaster
    ? (locations || []).map(l => l.id)
    : Object.entries(user.rolesByLocation || {})
        .filter(([, r]) => r === 'owner')
        .map(([loc]) => loc)

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Add Team Member</h2>
      <p className="text-sm text-un1t-subtle mb-6">Create a login for a new staff member</p>
      <StaffForm
        locations={locations || []}
        callerIsMaster={!!user.isMaster}
        callerOwnerLocationIds={callerOwnerLocationIds}
      />
    </div>
  )
}
