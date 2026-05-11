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
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function LandingPageSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.role !== 'master' && user.role !== 'owner') redirect('/')

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

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <h2 className="text-2xl font-bold">Landing page</h2>
        <p className="text-sm text-un1t-light mt-1">
          Edit the copy + media on the public marketing page at <code>/welcome</code>.
          Save here, refresh the public page to see changes.
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
