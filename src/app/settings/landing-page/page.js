// /settings/landing-page — operator-facing editor for the public
// marketing pages at /welcome/<studio>. Master/owner only by default
// (matches the table RLS write policy + the API gate).
//
// Multi-page (LP2LOC): un1tdublin.com now has one landing page per
// studio (landing_page_settings, keyed by location_id + public_path).
// This page lists every landing page the user can access and lets them
// pick which studio to edit via a dropdown in the form's top bar —
// WITHOUT changing their global active location. Selection is carried
// in ?location_id= so it's shareable + survives a refresh.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'

export const dynamic = 'force-dynamic'

export default async function LandingPageSettingsPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'landing_page')) redirect('/')

  const db = createServerClient()

  // Every landing page at a location the user can access. Master's
  // getUserLocationIds() returns all active locations; others get their
  // assigned ones. Each becomes an entry in the studio picker.
  const accessibleIds = getUserLocationIds(user)
  let pages = []
  if (accessibleIds.length > 0) {
    const { data } = await db
      .from('landing_page_settings')
      .select('location_id, public_path, locations:location_id ( name )')
      .in('location_id', accessibleIds)
    pages = (data || [])
      .map((r) => ({
        location_id: r.location_id,
        public_path: r.public_path,
        name: r.locations?.name || r.public_path || 'Studio',
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }

  // Selected page: ?location_id= when accessible, else the active
  // location's page, else the first available page, else the active
  // location id (so a brand-new location with no row still gets an
  // editor seeded with defaults).
  const requested = searchParams?.location_id
  const activeId = user.activeLocation?.id || null
  let selectedId = null
  if (requested && pages.some((p) => p.location_id === requested)) selectedId = requested
  else if (activeId && pages.some((p) => p.location_id === activeId)) selectedId = activeId
  else selectedId = pages[0]?.location_id || activeId || null

  if (!selectedId) {
    return (
      <div className="p-8 max-w-2xl">
        <h2 className="text-2xl font-bold mb-2">Landing page</h2>
        <p className="text-sm text-un1t-subtle">
          You don&apos;t have an active location. Switch to a location with the
          location picker top-right, then come back.
        </p>
      </div>
    )
  }

  const [settingsRes, eventTypesRes] = await Promise.all([
    db.from('landing_page_settings').select('*').eq('location_id', selectedId).maybeSingle(),
    db.from('event_types').select('id, name, slug').eq('location_id', selectedId).eq('active', true).order('name'),
  ])
  const selectedPage = pages.find((p) => p.location_id === selectedId) || null

  // Full-width container for the split-view editor. The form expands to
  // a live preview iframe alongside on xl+ screens.
  return (
    <div className="p-6 max-w-[1800px]">
      <div className="mb-4">
        <h2 className="text-2xl font-bold">Landing page</h2>
        <p className="text-sm text-un1t-subtle mt-1">
          Edit the copy + media on each studio&apos;s public marketing page. Use the
          <strong> Studio</strong> picker at the top to switch which page you&apos;re editing.
          On wide screens you&apos;ll see a live preview on the right — click any section in the preview to jump to its edit panel.
        </p>
      </div>
      {/* key=selectedId forces a clean remount (fresh form state) when
          the operator switches studio via the picker. */}
      <LandingPageSettingsForm
        key={selectedId}
        locationId={selectedId}
        publicPath={selectedPage?.public_path || null}
        pages={pages}
        initialSettings={settingsRes.data || null}
        availableBookingTypes={eventTypesRes.data || []}
      />
    </div>
  )
}
