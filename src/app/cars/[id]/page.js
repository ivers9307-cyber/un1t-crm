import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getCachedGbpToEur } from '@/lib/fx'
import CarDetail from '@/components/cars/CarDetail'

export const dynamic = 'force-dynamic'

export default async function CarDetailPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — coarse pre-check only; the decision is at the car's
  // location below, the same one every /api/cars/[id]/** route makes.
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) redirect('/')

  const db = createServerClient()
  const [{ data: car }, fx] = await Promise.all([
    db.from('cars').select('*, car_documents(*)').eq('id', params.id).single(),
    getCachedGbpToEur(),
  ])
  if (!car) notFound()
  if (assertLocationAccess(user, car.location_id)) notFound()
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) redirect('/')

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
