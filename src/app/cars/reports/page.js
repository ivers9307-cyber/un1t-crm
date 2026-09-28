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

  // TENANTSCOPE.1 — one studio, one legal entity: the report is the ACTIVE
  // studio's cars (the CSV export reads the same). No active studio means
  // an empty report that says so, never every tenant's cars.
  if (!locationId) {
    return (
      <CarsReports
        metrics={computeReportMetrics([], { liveRate: null })}
        error="No active location"
        fx={null}
      />
    )
  }

  const [{ data: cars, error }, fx] = await Promise.all([
    db.from('cars').select('*').eq('location_id', locationId),
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
