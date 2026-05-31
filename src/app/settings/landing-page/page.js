// /settings/landing-page — operator editor for the public marketing
// site. Master/owner only by default (matches the table RLS write
// policy + the API gate).
//
// Edits TWO kinds of public page, chosen via the top "Editing" picker:
//   1. Front page  (?page=chooser) — the un1tdublin.com split chooser
//      (ChooserEditorForm): headline/intro, tile order, per-tile
//      label / CTA / cover image.
//   2. A studio page (?location_id=<id>) — that studio's block-based
//      marketing page (LandingPageSettingsForm), with a live preview.
//
// The picker switches the edited page WITHOUT changing the user's
// global active location.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import ChooserEditorForm from '@/components/ChooserEditorForm'
import PageSwitcher from '@/components/landing-page/PageSwitcher'

export const dynamic = 'force-dynamic'

function canEditChooser(user) {
  return user?.profileRole === 'master' || user?.role === 'master' || user?.role === 'owner'
}

export default async function LandingPageSettingsPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'landing_page')) redirect('/')

  const db = createServerClient()

  // Studio pages the user can access (master = all active locations).
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

  // ── Front-page (chooser) mode ──────────────────────────────────────
  if (searchParams?.page === 'chooser' && canEditChooser(user)) {
    const [chooserRes, tilesRes] = await Promise.all([
      db.from('chooser_settings').select('*').eq('id', 'default').maybeSingle(),
      db.from('landing_page_settings')
        .select('location_id, public_path, chooser_label, chooser_cta_text, chooser_image_url, locations:location_id ( name )')
        .not('public_path', 'is', null),
    ])
    const tiles = (tilesRes.data || []).map((t) => ({
      location_id: t.location_id,
      public_path: t.public_path,
      name: t.locations?.name || t.public_path,
      chooser_label: t.chooser_label,
      chooser_cta_text: t.chooser_cta_text,
      chooser_image_url: t.chooser_image_url,
    }))
    return (
      <div className="p-6 max-w-[1800px]">
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold">Front page</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              The split landing page at <code>un1tdublin.com</code> — the two studio tiles visitors choose from.
            </p>
          </div>
          <PageSwitcher current="chooser" studios={pages} />
        </div>
        <ChooserEditorForm
          initialChooser={chooserRes.data || { id: 'default', headline: null, intro: null, tile_order: [] }}
          initialTiles={tiles}
        />
      </div>
    )
  }

  // ── Studio-page mode ───────────────────────────────────────────────
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

  const [settingsRes, eventTypesRes, eventsRes] = await Promise.all([
    db.from('landing_page_settings').select('*').eq('location_id', selectedId).maybeSingle(),
    db.from('event_types').select('id, name, slug').eq('location_id', selectedId).eq('active', true).order('name'),
    db.from('race_events').select('id, name, slug, kind').eq('location_id', selectedId).eq('active', true).order('race_date', { ascending: false }),
  ])
  const selectedPage = pages.find((p) => p.location_id === selectedId) || null

  return (
    <div className="p-6 max-w-[1800px]">
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Landing page</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            Edit a studio&apos;s public marketing page. Use the <strong>Editing</strong> picker to switch
            pages (or jump to the front page). On wide screens a live preview shows on the right —
            click any section to jump to its edit panel.
          </p>
        </div>
        {canEditChooser(user) && <PageSwitcher current={selectedId} studios={pages} />}
      </div>
      {/* key=selectedId forces a clean remount on studio switch. */}
      <LandingPageSettingsForm
        key={selectedId}
        locationId={selectedId}
        publicPath={selectedPage?.public_path || null}
        initialSettings={settingsRes.data || null}
        availableBookingTypes={eventTypesRes.data || []}
        availableEvents={eventsRes.data || []}
      />
    </div>
  )
}
