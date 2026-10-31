// /settings/landing-page — Settings → Landing pages (PAGES.1). Two modes:
//   1. No query: the Pages list (PagesList), every page the caller can view
//      (listPagesForUser) with "+ New page" (NewPageDialog). Every page, a
//      studio page included, is edited at /settings/landing-page/<id>.
//   2. ?page=chooser: the front-page (chooser) editor. The front page is per
//      ORGANISATION, so its editor is for organisation admins only (C141
//      ORGROLE.2: master or an org_admin grant), the same rule as
//      PUT /api/chooser-settings (assertChooserEdit). Anyone else gets the list.
//      Its tiles are the active organisation's kind='studio' pages, read as
//      GET /api/chooser-settings reads them (scoped by the organisation id).
// Any other query (the retired ?location_id= studio editor) gets the list.

import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import ChooserEditorForm from '@/components/ChooserEditorForm'
import PagesList from '@/components/landing-pages/PagesList'
import { isActiveOrgAdmin } from '@/lib/org-admin'
import { listPagesForUser, PageReadError } from '@/lib/landing-pages'
import { pageStateToTileState } from '@/lib/landing-page-visibility'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

function canEditChooser(user) {
  return isActiveOrgAdmin(user)
}

const backToPages = (
  <Link href="/settings/landing-page" className="text-sm font-medium text-un1t-accent hover:underline">
    Back to pages
  </Link>
)

const unreadable = (heading, what) => (
  <div className="p-8 max-w-2xl">
    <h2 className="text-2xl font-bold mb-2">{heading}</h2>
    <p className="text-sm text-un1t-subtle">{what} could not be loaded. Try again in a minute.</p>
  </div>
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
    return unreadable('Landing pages', 'The pages')
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

// The chooser mode: the front page's words and its tiles, one per studio page
// of the active organisation (the tile's label, button and cover live on the
// studio page's chrome; its state is the page's, draft and retired as hidden).
async function chooserMode(db, user) {
  const orgId = user.activeOrganization?.id || null
  const [chooserRes, tilesRes] = await Promise.all([
    db.from('chooser_settings').select('*').eq('id', 'default').maybeSingle(),
    orgId
      ? db.from('landing_pages')
        .select('primary_location_id, slug, chrome, publish_state, locations:primary_location_id ( name )')
        .eq('kind', 'studio')
        .eq('organization_id', orgId)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (chooserRes.error || tilesRes.error) {
    logError('landing-page-settings', 'front page unreadable', { orgId, code: (chooserRes.error || tilesRes.error)?.code ?? null })
    return unreadable('Front page', 'The front page')
  }
  const tiles = (tilesRes.data || []).map((t) => ({
    location_id: t.primary_location_id,
    public_path: t.slug,
    name: t.locations?.name || t.slug,
    chooser_label: t.chrome?.chooser_label ?? null,
    chooser_cta_text: t.chrome?.chooser_cta_text ?? null,
    chooser_image_url: t.chrome?.chooser_image_url ?? null,
    publish_state: pageStateToTileState(t.publish_state),
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

export default async function LandingPageSettingsPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'landing_page')) redirect('/')

  const db = createServerClient()
  if (searchParams?.page === 'chooser' && canEditChooser(user)) return chooserMode(db, user)
  return pagesListMode(db, user)
}
