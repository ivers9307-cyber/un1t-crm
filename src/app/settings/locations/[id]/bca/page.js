// /settings/locations/[id]/bca — per-location BCA Submit configuration.
//
// Master-only. The page is intentionally only routable when the location
// has features.bca_submit = true; otherwise we redirect back to the
// location settings page so there's no dead UI surface on UN1T sites.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canEditLocationFeatures } from '@/lib/staff-access'
import { getBcaConfig, isBcaSubmitEnabled, DEFAULT_BCA_CONFIG } from '@/lib/bca'
import BcaSubmitSettings from '@/components/settings/BcaSubmitSettings'

export const dynamic = 'force-dynamic'

export default async function BcaSettingsPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canEditLocationFeatures(user)) redirect('/')

  const db = createServerClient()
  const { data: location } = await db
    .from('locations')
    .select('id, name, features, bca_config')
    .eq('id', params.id)
    .single()
  if (!location) notFound()

  // If the feature is off at this location, bounce to the parent
  // settings page rather than render an unusable form. (Master can
  // turn it on in LocationFeatures first.)
  if (!isBcaSubmitEnabled(location)) {
    redirect(`/settings/locations/${location.id}`)
  }

  // getBcaConfig returns the merged-with-defaults config (or a fresh
  // default when bca_config is NULL on a newly-flagged location).
  const initialConfig = getBcaConfig(location) || { ...DEFAULT_BCA_CONFIG }

  // Pull a sample car at this location for the live template preview.
  // Prefer a pending car (operator-recognisable) over completed; falls
  // back to synthetic values inside the component if none exist.
  const { data: sampleCar } = await db
    .from('cars')
    .select('uk_reg, irish_reg, vin, make, model, vehicle_year, buyer_name, buyer_email, xero_invoice_number')
    .eq('location_id', location.id)
    .in('status', ['pending', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <div className="p-8">
      <Link
        href={`/settings/locations/${location.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-4"
      >
        <ArrowLeft size={14} /> Back to {location.name}
      </Link>
      <h2 className="text-2xl font-bold mb-1">BCA Submit</h2>
      <p className="text-sm text-un1t-light mb-6">
        Configure the 10-document UK VAT claim pack for cars at {location.name}.
        Labels appear on each car's BCA Submit card; the email is sent to BCA when the operator submits.
      </p>
      <BcaSubmitSettings
        location={location}
        initialConfig={initialConfig}
        sampleCar={sampleCar || null}
      />
    </div>
  )
}
