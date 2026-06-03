// /settings/locations/[id] — per-location edit page.
//
// SETTINGS.7 — the page is now a single tabbed surface. Previously every
// section (Details / Features / Branding / Deposits / Schedule /
// Notifications) stacked into one long scroll, with only the
// Integrations sub-area tabbed. Now a top-level tab strip (?section=)
// shows one section at a time, consistent with the Integrations tab
// (which keeps its own ?tab= sub-strip — the two params compose).
//
// SETTINGS.1 reorganized the page: every credential-bearing integration
// (Xero / Glofox / UniFi / Sensibo / BCA Submit / Twilio / WhatsApp)
// lives in the Integrations tab. The Details tab (LocationForm) owns
// location identity + Twilio alpha + contractor budget.

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

export default async function EditLocationPage(props) {
  const params = await props.params
  const searchParams = (await props.searchParams) || {}
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
      .select(`
        location_id, tenant_id, tenant_name, tenant_type,
        connected_at, last_refreshed_at, expires_at, scopes,
        bills_email_address,
        accounts_last_synced_at, contacts_last_synced_at,
        accounts_sync_error, contacts_sync_error,
        car_sales_account_code
      `)
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

  // Build the visible tab list. Features is master-only (per the mig 092
  // audit it's a master knob); Deposits only shows when car_processing is
  // on at this location. Same gates the old stacked layout used.
  const showFeatures = canEditLocationFeatures(user)
  const showDeposits = isFeatureEnabledAtLocation(location, 'car_processing')
  const tabs = [
    { key: 'details', label: 'Details' },
    ...(showFeatures ? [{ key: 'features', label: 'Features' }] : []),
    { key: 'branding', label: 'Branding' },
    ...(showDeposits ? [{ key: 'deposits', label: 'Deposits' }] : []),
    { key: 'schedule', label: 'Schedule' },
    { key: 'notifications', label: 'Notifications' },
    { key: 'integrations', label: 'Integrations' },
  ]
  const validKeys = new Set(tabs.map((t) => t.key))
  // Resolve the active section. If a `?tab=` is present (an Integrations
  // sub-tab deep-link, e.g. the documented /settings/locations/<id>?tab=xero)
  // but no `?section=`, default to the Integrations tab so the deep-link
  // still lands where it used to.
  const requestedSection = searchParams.section
  const active = validKeys.has(requestedSection)
    ? requestedSection
    : (searchParams.tab ? 'integrations' : 'details')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Edit Location</h2>
      <p className="text-sm text-un1t-subtle mb-6">Update {location.name} details and integrations</p>

      {/* Section tab strip (?section=). Server-rendered Links so each
          section is a shareable URL; switching sections drops any stale
          ?tab= from the query (a bare ?section= replaces the query). */}
      <div className="flex border-b border-un1t-border overflow-x-auto mb-6">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`?section=${t.key}`}
            className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              active === t.key
                ? 'border-un1t-text text-un1t-text'
                : 'border-transparent text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {active === 'details' && (
        <LocationForm location={location} callerRole={user.role} organizations={organizations || []} />
      )}

      {/* Features matrix — master only. */}
      {active === 'features' && showFeatures && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <ToggleRight size={16} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Features</h3>
          </div>
          <LocationFeatures location={location} />
        </section>
      )}

      {/* Branding — logo + favicon + company name. Drives buyer-facing
          surfaces (deposit page, BCA download page, etc). */}
      {active === 'branding' && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <ImageIcon size={16} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Branding</h3>
          </div>
          <BrandingSettings user={user} locationId={location.id} />
        </section>
      )}

      {/* Car deposit settings — default amount, terms, receipt toggle. */}
      {active === 'deposits' && showDeposits && (
        <CarDepositSettings location={location} />
      )}

      {/* Schedule data: shift templates + bank holidays. Both are
          location-scoped (mig 098); the linked pages scope by
          user.activeLocation, so set the active location to this studio
          before clicking or you'll edit a different studio's data. */}
      {active === 'schedule' && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Schedule</h3>
          </div>
          <div className="space-y-2">
            <Link
              href="/settings/shifts"
              className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
            >
              <div>
                <div className="text-un1t-text inline-flex items-center gap-2">
                  <Clock size={14} className="text-un1t-subtle" /> Shift templates
                </div>
                <div className="text-xs text-un1t-subtle mt-1">
                  Named shifts (Morning, Afternoon, Evening) used when building the weekly roster at this location.
                </div>
              </div>
              <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text" />
            </Link>
            <Link
              href="/settings/holidays"
              className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
            >
              <div>
                <div className="text-un1t-text inline-flex items-center gap-2">
                  <CalendarDays size={14} className="text-un1t-subtle" /> Bank holidays
                </div>
                <div className="text-xs text-un1t-subtle mt-1">
                  Public holidays for {location.country || 'IE'} auto-highlight on the schedule. Add custom closures (Good Friday, Christmas Eve early-close) per location.
                </div>
              </div>
              <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text" />
            </Link>
          </div>
        </section>
      )}

      {/* Notification config (NOTIF.3) — lead times + booking notify-roles
          for the send-push-reminders cron. */}
      {active === 'notifications' && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Bell size={16} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Push notifications</h3>
          </div>
          <NotificationConfigCard locationId={location.id} callerRole={user.role} />
        </section>
      )}

      {/* Tabbed Integrations — Xero / Glofox / Twilio / UniFi / Sensibo /
          BCA / WhatsApp. Keeps its own ?tab= sub-strip; each tab is
          visible only when its feature is on at this location. */}
      {active === 'integrations' && (
        <LocationIntegrations
          location={location}
          xeroConnection={xeroConnection || null}
          user={user}
          sampleBcaCar={sampleBcaCar || null}
        />
      )}
    </div>
  )
}
