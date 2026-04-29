import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import LocationForm from '@/components/LocationForm'

export const dynamic = 'force-dynamic'

export default async function NewLocationPage() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'owner') redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Add Location</h2>
      <p className="text-sm text-un1t-light mb-6">Set up a new gym location with its own integrations</p>
      <LocationForm />
    </div>
  )
}
