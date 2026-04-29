import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import LocationForm from '@/components/LocationForm'

export const dynamic = 'force-dynamic'

export default async function EditLocationPage({ params }) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'owner') redirect('/')

  const db = createServerClient()
  const { data: location } = await db
    .from('locations')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!location) notFound()

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit Location</h2>
      <p className="text-sm text-un1t-light mb-6">Update {location.name} details and integrations</p>
      <LocationForm location={location} />
    </div>
  )
}
