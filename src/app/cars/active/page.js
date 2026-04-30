import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import { getCachedGbpToEur } from '@/lib/fx'
import CarsList from '@/components/cars/CarsList'
import AddCarButton from '@/components/cars/AddCarButton'

export const dynamic = 'force-dynamic'

// Active = new + pending. Replaces the old separate /cars/new and
// /cars/pending tabs — the in-flight workload sits in one list with
// per-row status badges so the operator can still scan the new vs
// pending split at a glance.
export default async function ActiveCarsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')

  const fx = await getCachedGbpToEur()
  const liveFxRate = fx?.rate ?? null

  return (
    <CarsList
      statuses={['new', 'pending']}
      locationId={user.activeLocation?.id}
      liveFxRate={liveFxRate}
      addButton={<AddCarButton locationId={user.activeLocation?.id} liveFxRate={liveFxRate} />}
      emptyText="No active cars — start by adding one."
    />
  )
}
