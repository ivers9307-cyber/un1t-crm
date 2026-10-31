// /settings/landing-page — Settings → Landing pages (PAGES.1). Three modes:
//   1. No query: the Pages list (PagesList), every page the caller can view
//      (listPagesForUser) with "+ New page" (NewPageDialog).
//   2. ?page=chooser: the front-page (chooser) editor. The front page is per
//      ORGANISATION, so its editor is for organisation admins only (C141
//      ORGROLE.2: master or an org_admin grant), the same rule as
//      PUT /api/chooser-settings (assertChooserEdit). Anyone else gets the list.
//   3. ?location_id=<id>: the legacy studio editor (LandingPageSettingsForm),
//      which still edits a studio page until studio pages move to the page
//      editor in PR3. A studio row's Edit link opens it.
// A campaign page's editor is /settings/landing-page/<id>.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import Link from 'next/link'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import { getLocationBranding } from '@/lib/location-branding'
import ChooserEditorForm from '@/components/ChooserEditorForm'
import PagesList from '@/components/landing-pages/PagesList'
import { isActiveOrgAdmin } from '@/lib/org-admin'
import { listPagesForUser, PageReadError } from '@/lib/landing-pages'
import { logError, logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

function canEditChooser(user) {
  return isActiveOrgAdmin(user)
}

const backToPages = (
  <Link href="/settings/landing-page" className="text-sm font-medium text-un1t-accent hover:underline">
    Back to pages
  </Link>
)

// The list mode: the pages, and who may make a new one. A one-studio page
// needs the landing_page permission AT that studio (the POST route's rule);
// an all-studios page needs an organisation admin.
async function pagesListMode(db, user) {
  let pages
  try {
    pages = await listPagesForUser(db, user)
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-page-settings', 'pages list unreadable', { code: err.cause?.code ?? null })
    return (
      <div className="p-8 max-w-2xl">
        <h2 className="text-2xl font-bold mb-2">Landing pages</h2>
        <p className="text-sm text-un1t-subtle">The pages could not be loaded. Try again in a minute.</p>
      </div>
    )
  }
  const studios = (user.locations || [])
    .filter((l) => hasPermissionForLocation(user, l.id, 'landing_page'))
    .map((l) => ({ id: l.id, name: l.name || 'Studio' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const canCreateAll = isActiveOrgAdmin(user)
  return (
    <div className="p-6 max-w-[1800px]">
      <PagesList
        pages={pages}
        studios={studios}
        canCreate={canCreateAll || studios.length > 0}
        canCreateAll={canCreateAll}
        showFrontPage={canCreateAll}
      />
    </div>
  )
}

export default async function LandingPageSettingsPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'landing_page')) redirect('/')

  const db = createServerClient()

  // ── Front-page (chooser) mode ──────────────────────────────────────
  if (searchParams?.page === 'chooser' && canEditChooser(user)) {
    const [chooserRes, tilesRes] = await Promise.all([
      db.from('chooser_settings').select('*').eq('id', 'default').maybeSingle(),
      db.from('landing_page_settings')
        .select('location_id, public_path, chooser_label, chooser_cta_text, chooser_image_url, publish_state, locations:location_id ( name )')
        .not('public_path', 'is', null),
    ])
    const tiles = (tilesRes.data || []).map((t) => ({
      location_id: t.location_id,
      public_path: t.public_path,
      name: t.locations?.name || t.public_path,
      chooser_label: t.chooser_label,
      chooser_cta_text: t.chooser_cta_text,
      chooser_image_url: t.chooser_image_url,
      publish_state: t.publish_state,
    }))
    return (
      <div className="p-6 max-w-[1800px]">
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold">Front page</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              The split landing page at <code>un1tdublin.com</code>: the two studio tiles visitors choose from.
            </p>
          </div>
          {backToPages}
        </div>
        <ChooserEditorForm
          initialChooser={chooserRes.data || { id: 'default', headline: null, intro: null, tile_order: [] }}
          initialTiles={tiles}
        />
      </div>
    )
  }

  // ── Studio-page mode (legacy editor) ───────────────────────────────
  const requested = searchParams?.location_id
  if (!requested) return pagesListMode(db, user)

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

  const activeId = user.activeLocation?.id || null
  let selectedId = null
  if (pages.some((p) => p.location_id === requested)) selectedId = requested
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

  const [settingsRes, eventTypesRes, eventsRes, brand, locRes] = await Promise.all([
    db.from('landing_page_settings').select('*').eq('location_id', selectedId).maybeSingle(),
    db.from('event_types').select('id, name, slug').eq('location_id', selectedId).eq('active', true).order('name'),
    db.from('race_events').select('id, name, slug, kind').eq('location_id', selectedId).eq('active', true).order('race_date', { ascending: false }),
    // W1.S1b — the studio's brand for the editor's defaults and hints.
    getLocationBranding(db, selectedId),
    // The paid-trial block editor shows the product picker for the studio's rail.
    db.from('locations').select('membership_source').eq('id', selectedId).maybeSingle(),
  ])
  if (locRes?.error) {
    logWarn('landing-page-settings', 'membership_source unreadable; editor falls back to Glofox fields', { locationId: selectedId, code: locRes.error.code })
  }
  const selectedPage = pages.find((p) => p.location_id === selectedId) || null

  return (
    <div className="p-6 max-w-[1800px]">
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Landing page</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            Edit a studio&apos;s public marketing page. On wide screens a live preview shows on the
            right: click any section to jump to its edit panel.
          </p>
        </div>
        {backToPages}
      </div>
      {/* key=selectedId forces a clean remount on studio switch. */}
      <LandingPageSettingsForm
        key={selectedId}
        locationId={selectedId}
        membershipSource={locRes?.data?.membership_source || null}
        publicPath={selectedPage?.public_path || null}
        initialSettings={settingsRes.data || null}
        availableBookingTypes={eventTypesRes.data || []}
        availableEvents={eventsRes.data || []}
        brand={{ companyName: brand.companyName, shortName: brand.shortName }}
      />
    </div>
  )
}
