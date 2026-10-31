// /settings/landing-page/<id> — the page editor (PAGES.1): one landing_pages
// row in LandingPageSettingsForm's page mode, with PageHeaderCard above it.
//
// Service role, so access is decided here: an id that is not a uuid, an
// unknown page and a page outside canViewPage are all notFound() (the GET
// route's 404 rule). canEditPage decides read-only; a viewer who may not edit
// never receives a studio row's offer or attribution (the GET route's rule),
// and gets the blocks through clientSafeBlocks (EDITGATE.1: a backfilled block
// may still carry operator keys).
// The studio lists (booking types, events) are read for a one-studio page's
// studio only. Each studio row carries its readiness (studioRowReadiness, the
// API's rule) so the editor's chip starts right; an unreadable one is left
// unknown. A studio page (kind 'studio') opens here READ-ONLY for everyone,
// under a banner pointing at the legacy editor: landing_page_settings stays
// its one writer until PR3's cutover re-syncs it (the API refuses the write
// too, 400 studio_page).

import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { getLocationBranding } from '@/lib/location-branding'
import { resolveOrgChrome } from '@/lib/host-brand'
import { clientSafeBlocks } from '@/lib/landing-page-blocks'
import {
  loadPageById, canViewPage, canEditPage, studioRowView, studioPublicPath, studioRowReadiness, PageReadError,
} from '@/lib/landing-pages'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

const EMPTY = Promise.resolve({ data: [] })

function studiosFor(rows, canEdit, paths, readiness) {
  return rows.map((row, i) => {
    const view = { ...studioRowView(row, { publicPath: paths.get(row.location_id) ?? null }), ...(readiness[i] ? { readiness: readiness[i] } : {}) }
    if (canEdit) return view
    const { offer: _offer, attribution: _attribution, ...rest } = view
    return rest
  })
}

// Each row's readiness, judged with the path already read. Only when the path
// is known (an unknown path is not "no platform"); a failed read leaves that
// row's readiness unknown (logged) and the editor shows its local hint.
async function readinessFor(db, page, rows, paths) {
  return Promise.all(rows.map(async (row) => {
    if (!paths.has(row.location_id)) return null
    try {
      return await studioRowReadiness(db, { page, row, publicPath: paths.get(row.location_id) })
    } catch (err) {
      if (!(err instanceof PageReadError)) throw err
      logError('landing-page-settings', 'studio readiness unreadable', { pageId: page.id, locationId: row.location_id, code: err.cause?.code ?? null })
      return null
    }
  }))
}

// Each studio's public path (one read per studio), for the editor's default
// tag. Only a hint: an unreadable path leaves it unknown (logged), never the page.
async function studioPathsFor(db, rows, pageId) {
  try {
    return new Map(await Promise.all(rows.map(async (r) => [r.location_id, await studioPublicPath(db, r.location_id)])))
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-page-settings', 'studio path unreadable', { pageId, code: err.cause?.code ?? null })
    return new Map()
  }
}

async function brandFor(db, page, primary) {
  const brand = primary
    ? await getLocationBranding(db, primary)
    : await resolveOrgChrome({ orgId: page.organization_id, db })
  return { companyName: brand?.companyName || '', shortName: brand?.shortName || '' }
}

export default async function LandingPageEditorPage(props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'landing_page')) redirect('/')
  if (!uuidLike.safeParse(id).success) notFound()

  const db = createServerClient()
  let loaded
  try {
    loaded = await loadPageById(db, id)
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-page-settings', 'page unreadable', { pageId: id, code: err.cause?.code ?? null })
    return (
      <div className="p-8 max-w-2xl">
        <h2 className="text-2xl font-bold mb-2">Landing page</h2>
        <p className="text-sm text-un1t-subtle">The page could not be loaded. Try again in a minute.</p>
      </div>
    )
  }
  if (!loaded || !canViewPage(user, loaded.page)) notFound()

  const { page } = loaded
  const isStudioPage = page.kind === 'studio'
  const canEdit = !isStudioPage && canEditPage(user, page)
  const primary = page.scope === 'one' ? page.primary_location_id : null
  const [eventTypesRes, eventsRes, brand, paths] = await Promise.all([
    primary ? db.from('event_types').select('id, name, slug').eq('location_id', primary).eq('active', true).order('name') : EMPTY,
    primary ? db.from('race_events').select('id, name, slug, kind').eq('location_id', primary).eq('active', true).order('race_date', { ascending: false }) : EMPTY,
    brandFor(db, page, primary),
    studioPathsFor(db, loaded.studios, page.id),
  ])
  const readiness = await readinessFor(db, page, loaded.studios, paths)

  return (
    <div className="p-6 max-w-[1800px]">
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Landing page</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            Edit this page&apos;s sections. On wide screens a live preview shows on the right: click any section to jump to its edit panel.
          </p>
        </div>
        <Link href="/settings/landing-page" className="text-sm font-medium text-un1t-accent hover:underline">
          Back to pages
        </Link>
      </div>
      {isStudioPage && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          This studio page is edited from the Landing page editor until studio pages move here.{' '}
          <Link
            href={`/settings/landing-page?location_id=${encodeURIComponent(page.primary_location_id || '')}`}
            className="font-medium underline"
          >
            Open the Landing page editor
          </Link>
        </div>
      )}
      <LandingPageSettingsForm
        key={page.id}
        page={canEdit ? page : { ...page, blocks: clientSafeBlocks(page.blocks) }}
        studios={studiosFor(loaded.studios, canEdit, paths, readiness)}
        canEdit={canEdit}
        availableBookingTypes={eventTypesRes.data || []}
        availableEvents={eventsRes.data || []}
        brand={brand}
      />
    </div>
  )
}
