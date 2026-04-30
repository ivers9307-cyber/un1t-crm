import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import CarsList from '@/components/cars/CarsList'
import AddCarButton from '@/components/cars/AddCarButton'

export const dynamic = 'force-dynamic'

export default async function NewCarsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')

  return (
    <CarsList
      status="new"
      locationId={user.activeLocation?.id}
      addButton={<AddCarButton locationId={user.activeLocation?.id} />}
    />
  )
}
