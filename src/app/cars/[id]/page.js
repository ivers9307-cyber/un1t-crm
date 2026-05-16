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

  // Look up the BCA feature flag for the car's location so CarDetail
  // can decide whether to render BcaSubmitCard. Full config is fetched
  // client-side by the card itself — we only need the boolean here so
  // the card chunk isn't shipped on locations where the feature is off.
  const { data: locationFeatures } = await db
    .from('locations')
    .select('features')
    .eq('id', car.location_id)
    .single()
  const bcaEnabled = locationFeatures?.features?.bca_submit === true

  return (
    <CarDetail
      car={car}
      liveFxRate={fx?.rate ?? null}
      fxFetchedAt={fx?.fetched_at ?? null}
      bcaEnabled={bcaEnabled}
    />
  )
}
