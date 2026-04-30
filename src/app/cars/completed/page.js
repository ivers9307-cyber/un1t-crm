import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import CarsList from '@/components/cars/CarsList'

export const dynamic = 'force-dynamic'

export default async function CompletedCarsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')
  return (
    <CarsList
      statuses={['completed']}
      locationId={user.activeLocation?.id}
      emptyText="No completed cars yet."
    />
  )
}
