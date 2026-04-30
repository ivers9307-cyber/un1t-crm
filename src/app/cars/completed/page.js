import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import { getCachedGbpToEur } from '@/lib/fx'
import CarsList from '@/components/cars/CarsList'

export const dynamic = 'force-dynamic'

export default async function CompletedCarsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')
  const fx = await getCachedGbpToEur()
  return (
    <CarsList
      statuses={['completed']}
      locationId={user.activeLocation?.id}
      liveFxRate={fx?.rate ?? null}
      emptyText="No completed cars yet."
    />
  )
}
