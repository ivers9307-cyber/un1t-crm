import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getCachedGbpToEur } from '@/lib/fx'
import CarDetail from '@/components/cars/CarDetail'

export const dynamic = 'force-dynamic'

export default async function CarDetailPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')

  const db = createServerClient()
  const [{ data: car }, fx] = await Promise.all([
    db.from('cars').select('*, car_documents(*)').eq('id', params.id).single(),
    getCachedGbpToEur(),
  ])
  if (!car) notFound()
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) redirect('/cars')

  return <CarDetail car={car} liveFxRate={fx?.rate ?? null} fxFetchedAt={fx?.fetched_at ?? null} />
}
