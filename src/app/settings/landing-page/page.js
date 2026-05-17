// /settings/landing-page — operator-facing form to edit the public
// marketing page at /welcome. Master/owner only (matches the table's
// RLS write policy + the API gate).
//
// Server component — pulls the current settings + active location
// + available booking-type slugs (for the slug picker dropdown),
// then mounts the client form.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'

export const dynamic = 'force-dynamic'

export default async function LandingPageSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Permission gate — 3-tier resolver: location feature gate →
  // per-user override → role default. Defaults to owner+master
  // per shared/permissions.js. Replaces the older role-only
  // (master OR owner) check so the LocationFeatures matrix can
  // disable landing-page editing per-location and operators can
  // grant/revoke per-user from StaffForm.
  if (!hasPermission(user, 'landing_page')) redirect('/')

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return (
      <div className="p-8 max-w-2xl">
        <h2 className="text-2xl font-bold mb-2">Landing page</h2>
        <p className="text-sm text-un1t-light">
          You don&apos;t have an active location. Switch to a location with the
          location picker top-right, then come back.
        </p>
      </div>
    )
  }

  const db = createServerClient()
  const [settingsRes, eventTypesRes] = await Promise.all([
    db.from('landing_page_settings').select('*').eq('location_id', locationId).maybeSingle(),
    db.from('event_types').select('id, name, slug').eq('location_id', locationId).eq('active', true).order('name'),
  ])

  // Full-width container for the Phase 3c split-view editor. The
  // form expands to use the live preview iframe alongside on
  // xl+ screens; on smaller screens the iframe hides and the form
  // takes the full width so a small laptop screen still gets a
  // usable editor.
  return (
    <div className="p-6 max-w-[1800px]">
      <div className="mb-4">
        <h2 className="text-2xl font-bold">Landing page</h2>
        <p className="text-sm text-un1t-light mt-1">
          Edit the copy + media on the public marketing page at <code>/welcome</code>.
          On wide screens you&apos;ll see a live preview on the right — click any section in the preview to jump to its edit panel.
        </p>
      </div>

      <LandingPageSettingsForm
        locationId={locationId}
        initialSettings={settingsRes.data || null}
        availableBookingTypes={eventTypesRes.data || []}
      />
    </div>
  )
}
