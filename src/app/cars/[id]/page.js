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

  // Look up the BCA feature flag for the car's location + whether
  // there's an active non-error submission for this car. CarDetail
  // uses the first to decide whether to render BcaSubmitCard at all,
  // and both feed into completionGaps() so the "Mark completed" gate
  // refuses without a successful submission when the feature is on.
  // BcaSubmitCard fetches its own data client-side; these two
  // booleans are the minimum the server-render needs.
  const [
    { data: locationFeatures },
    { count: activeBcaCount },
  ] = await Promise.all([
    db.from('locations').select('features').eq('id', car.location_id).single(),
    db.from('car_bca_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('car_id', car.id)
      .is('superseded_at', null)
      .not('postmark_message_id', 'is', null),
  ])
  const bcaEnabled = locationFeatures?.features?.bca_submit === true
  const hasActiveBcaSubmission = (activeBcaCount || 0) > 0

  return (
    <CarDetail
      car={car}
      liveFxRate={fx?.rate ?? null}
      fxFetchedAt={fx?.fetched_at ?? null}
      bcaEnabled={bcaEnabled}
      hasActiveBcaSubmission={hasActiveBcaSubmission}
    />
  )
}
