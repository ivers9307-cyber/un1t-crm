// /settings/locations/[id] — per-location edit page.
//
// SETTINGS.1 reorganized this page: every credential-bearing
// integration (Xero / Glofox / UniFi / Sensibo / BCA Submit) now
// lives in a tabbed "Integrations" section at the bottom. The
// LocationForm above only owns location identity + Twilio alpha +
// contractor budget. Features matrix + Branding + Car Deposit are
// unchanged, sitting between LocationForm and Integrations.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ToggleRight, Image as ImageIcon, Clock, CalendarDays, ChevronRight, Bell } from 'lucide-react'
import { isFeatureEnabledAtLocation } from '@shared/permissions'
import { canEditLocationFeatures } from '@/lib/staff-access'
import LocationForm from '@/components/LocationForm'
import LocationFeatures from '@/components/LocationFeatures'
import CarDepositSettings from '@/components/CarDepositSettings'
import BrandingSettings from '@/components/BrandingSettings'
import LocationIntegrations from '@/components/settings/LocationIntegrations'
import NotificationConfigCard from '@/components/settings/NotificationConfigCard'

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
    db.from('organizations').select('*').eq('active', true).order('name'),
  ])

  if (!location) notFound()

  // Pull the Xero connection row (if any) and a sample car for the
  // BCA template preview. Both feed into LocationIntegrations.
  const [{ data: xeroConnection }, { data: sampleBcaCar }] = await Promise.all([
    db.from('xero_connections')
      .select('location_id, tenant_id, tenant_name, tenant_type, connected_at, last_refreshed_at, expires_at, scopes, bills_email_address')
      .eq('location_id', location.id)
      .maybeSingle(),
    location.features?.bca_submit === true
      ? db.from('cars')
          .select('uk_reg, irish_reg, vin, make, model, vehicle_year, buyer_name, buyer_email, xero_invoice_number')
          .eq('location_id', location.id)
          .in('status', ['pending', 'completed'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Edit Location</h2>
      <p className="text-sm text-un1t-light mb-6">Update {location.name} details and integrations</p>

      <LocationForm location={location} callerRole={user.role} organizations={organizations || []} />

      {/* Features matrix — master only. Hides for owners (RLS would
          allow it but per the audit it's a master-only knob since
          features affect every operator at the location). */}
      {canEditLocationFeatures(user) && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-3">
            <ToggleRight size={16} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Features</h3>
          </div>
          <LocationFeatures location={location} />
        </section>
      )}

      {/* Branding — logo + favicon + company name. Drives buyer-
          facing surfaces (deposit page, BCA download page, etc).
          Same access gate as the rest of the page. */}
      <section className="mt-10">
        <div className="flex items-center gap-2 mb-3">
          <ImageIcon size={16} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Branding</h3>
        </div>
        <BrandingSettings user={user} locationId={location.id} />
      </section>

      {/* Car deposit settings — operational config (default amount,
          terms, WhatsApp template) for the car-processing flow. Stays
          out of Integrations because it's not credential-bearing. */}
      {isFeatureEnabledAtLocation(location, 'car_processing') && (
        <CarDepositSettings location={location} />
      )}

      {/* Schedule data: shift templates + bank holidays. Both are
          location-scoped (mig 098 shift_templates.location_id,
          location_holidays.location_id) so they live here rather
          than at top-level settings. The existing /settings/shifts
          and /settings/holidays pages scope by user.activeLocation —
          make sure that's set to this location before clicking, or
          you'll edit a different studio's data. */}
      <section className="mt-10">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={16} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Schedule</h3>
        </div>
        <div className="space-y-2">
          <Link
            href="/settings/shifts"
            className="bg-un1t-dark border border-un1t-gray hover:border-un1t-light rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div>
              <div className="text-un1t-white inline-flex items-center gap-2">
                <Clock size={14} className="text-un1t-light" /> Shift templates
              </div>
              <div className="text-xs text-un1t-light mt-1">
                Named shifts (Morning, Afternoon, Evening) used when building the weekly roster at this location.
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-light group-hover:text-un1t-white" />
          </Link>
          <Link
            href="/settings/holidays"
            className="bg-un1t-dark border border-un1t-gray hover:border-un1t-light rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div>
              <div className="text-un1t-white inline-flex items-center gap-2">
                <CalendarDays size={14} className="text-un1t-light" /> Bank holidays
              </div>
              <div className="text-xs text-un1t-light mt-1">
                Public holidays for {location.country || 'IE'} auto-highlight on the schedule. Add custom closures (Good Friday, Christmas Eve early-close) per location.
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-light group-hover:text-un1t-white" />
          </Link>
        </div>
      </section>

      {/* Notification config (NOTIF.3) — lead times + booking
          notify-roles for the send-push-reminders cron. Not
          credential-bearing so it lives outside the Integrations
          tab strip; owner + master can edit. */}
      <section className="mt-10">
        <div className="flex items-center gap-2 mb-3">
          <Bell size={16} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Push notifications</h3>
        </div>
        <NotificationConfigCard locationId={location.id} callerRole={user.role} />
      </section>

      {/* Tabbed Integrations — Xero / Glofox / Twilio / UniFi / Sensibo
          / BCA. Each tab visible only when its feature is on at this
          location. Tab strip uses ?tab= query param for shareable
          URLs. */}
      <LocationIntegrations
        location={location}
        xeroConnection={xeroConnection || null}
        user={user}
        sampleBcaCar={sampleBcaCar || null}
      />
    </div>
  )
}
