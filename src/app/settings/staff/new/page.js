import { createServerClient, getCurrentUser } from '@/lib/supabase'
import { redirect } from 'next/navigation'
import StaffForm from '@/components/StaffForm'

export const dynamic = 'force-dynamic'

export default async function NewStaffPage() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'owner') redirect('/')

  const db = createServerClient()
  const { data: locations } = await db.from('locations').select('*').eq('active', true).order('name')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Add Team Member</h2>
      <p className="text-sm text-un1t-light mb-6">Create a login for a new staff member</p>
      <StaffForm locations={locations || []} />
    </div>
  )
}
