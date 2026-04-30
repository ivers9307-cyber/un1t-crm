// /cars/reports — fleet-wide metrics for the Tesla import side-business.
//
// Computes everything server-side from a single SELECT against `cars`
// (no documents needed for these numbers — costs and refund-state
// already live on the cars row). Same FX rate as the rest of the
// Cars module so figures reconcile against individual detail pages.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getCachedGbpToEur } from '@/lib/fx'
import { computeReportMetrics } from '@/lib/cars'
import CarsReports from '@/components/cars/CarsReports'

export const dynamic = 'force-dynamic'

export default async function CarsReportsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')

  const db = createServerClient()
  const locationId = user.activeLocation?.id

  let query = db.from('cars').select('*')
  if (locationId) query = query.eq('location_id', locationId)
  const [{ data: cars, error }, fx] = await Promise.all([
    query,
    getCachedGbpToEur(),
  ])

  const liveFxRate = fx?.rate ?? null
  const metrics = computeReportMetrics(cars || [], { liveRate: liveFxRate })

  return (
    <CarsReports
      metrics={metrics}
      error={error?.message || null}
      fx={fx}
    />
  )
}
