import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import { ToggleRight } from 'lucide-react'
import LocationForm from '@/components/LocationForm'
import LocationFeatures from '@/components/LocationFeatures'
import CarDepositSettings from '@/components/CarDepositSettings'

export const dynamic = 'force-dynamic'

export default async function EditLocationPage({ params }) {
  const user = await getCurrentUser()
  // Master OR owner can edit existing locations. Master sees every
  // location automatically; owners see locations they're members of
  // (RLS already enforces row visibility).
  if (!user || (user.role !== 'master' && user.role !== 'owner')) redirect('/')

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
      <LocationForm location={location} callerRole={user.role} />

      <section className="mt-10">
        <div className="flex items-center gap-2 mb-3">
          <ToggleRight size={16} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Features</h3>
        </div>
        <LocationFeatures location={location} />
      </section>

      <CarDepositSettings location={location} />
    </div>
  )
}
