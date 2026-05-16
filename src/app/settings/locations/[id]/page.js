import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ToggleRight, Image as ImageIcon, FileCheck, ChevronRight } from 'lucide-react'
import { isFeatureEnabledAtLocation } from '@shared/permissions'
import { canEditLocationFeatures } from '@/lib/staff-access'
import LocationForm from '@/components/LocationForm'
import LocationFeatures from '@/components/LocationFeatures'
import CarDepositSettings from '@/components/CarDepositSettings'
import BrandingSettings from '@/components/BrandingSettings'

export const dynamic = 'force-dynamic'

export default async function EditLocationPage({ params }) {
  const user = await getCurrentUser()
  // Master OR owner can edit existing locations. Master sees every
  // location automatically; owners see locations they're members of
  // (RLS already enforces row visibility).
  if (!user || (user.role !== 'master' && user.role !== 'owner')) redirect('/')

  const db = createServerClient()
  const [{ data: location }, { data: organizations }] = await Promise.all([
    db.from('locations').select('*').eq('id', params.id).single(),
    // Orgs powers the read-only org display in LocationForm (mig 079).
    // Fetched even on edit so the form can resolve organization_id → name.
    db.from('organizations').select('*').eq('active', true).order('name'),
  ])

  if (!location) notFound()

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit Location</h2>
      <p className="text-sm text-un1t-light mb-6">Update {location.name} details and integrations</p>
      <LocationForm location={location} callerRole={user.role} organizations={organizations || []} />

      {/* Features matrix is master-only. Owners can still edit
          their location's name / address / branding / UniFi config
          via LocationForm above; only the per-location feature
          toggles are restricted. canEditLocationFeatures() is the
          canonical check (`@/lib/staff-access`). */}
      {canEditLocationFeatures(user) && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-3">
            <ToggleRight size={16} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Features</h3>
          </div>
          <LocationFeatures location={location} />
        </section>
      )}

      {/* Per-location branding (logo + favicon + company name).
          Drives the favicon and tab title on this location's
          buyer-facing surfaces — the deposit page on
          pay.ccfautos.com pulls the car's location's branding so
          CCF Autos buyers see CCF Autos branding while UN1T's
          gym-side pages still get UN1T's. Same access gate as the
          rest of the page (master OR owner-at-this-location). */}
      <section className="mt-10">
        <div className="flex items-center gap-2 mb-3">
          <ImageIcon size={16} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Branding</h3>
        </div>
        <BrandingSettings user={user} locationId={location.id} />
      </section>

      {/* Car deposit settings are only relevant when this location
          has the Car Processing feature enabled. Hides the section
          for gym-only locations so the page doesn't carry settings
          that would never apply. Toggling Car Processing back on
          restores the section without a refresh (LocationFeatures
          calls router.refresh() after save). */}
      {isFeatureEnabledAtLocation(location, 'car_processing') && (
        <CarDepositSettings location={location} />
      )}

      {/* BCA Submit settings — only when the bca_submit feature flag
          is explicitly on (opt-in per location; CCFA is the only one
          today). Links out to a dedicated sub-page because the config
          surface is substantial (emails, templates, 10 doc labels). */}
      {location.features?.bca_submit === true && canEditLocationFeatures(user) && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-3">
            <FileCheck size={16} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">BCA Submit</h3>
          </div>
          <Link
            href={`/settings/locations/${location.id}/bca`}
            className="bg-un1t-dark border border-un1t-gray hover:border-un1t-light rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div>
              <div className="text-un1t-white">Edit document labels + email config</div>
              <div className="text-xs text-un1t-light mt-0.5">
                10-doc UK VAT claim pack — send-from / send-to / subject / body / slot labels
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-light group-hover:text-un1t-white" />
          </Link>
        </section>
      )}
    </div>
  )
}
