// /settings/landing-page/<id> — the page editor (PAGES.1): one landing_pages
// row in LandingPageSettingsForm's page mode, with PageHeaderCard above it.
//
// Service role, so access is decided here: an id that is not a uuid, an
// unknown page and a page outside canViewPage are all notFound() (the GET
// route's 404 rule). canEditPage decides read-only; a viewer who may not edit
// never receives a studio row's offer or attribution (the GET route's rule).
// The studio lists (booking types, events) are read for a one-studio page's
// studio only. A studio page (kind 'studio') opens here too, under a banner:
// the public site still renders it from the legacy table until PR3.

import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { getLocationBranding } from '@/lib/location-branding'
import { resolveOrgChrome } from '@/lib/host-brand'
import { loadPageById, canViewPage, canEditPage, studioRowView, PageReadError } from '@/lib/landing-pages'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

const EMPTY = Promise.resolve({ data: [] })

function studiosFor(rows, canEdit) {
  return rows.map((row) => {
    const view = studioRowView(row)
    if (canEdit) return view
    const { offer: _offer, attribution: _attribution, ...rest } = view
    return rest
  })
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
  const canEdit = canEditPage(user, page)
  const primary = page.scope === 'one' ? page.primary_location_id : null
  const [eventTypesRes, eventsRes, brand] = await Promise.all([
    primary ? db.from('event_types').select('id, name, slug').eq('location_id', primary).eq('active', true).order('name') : EMPTY,
    primary ? db.from('race_events').select('id, name, slug, kind').eq('location_id', primary).eq('active', true).order('race_date', { ascending: false }) : EMPTY,
    brandFor(db, page, primary),
  ])

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
      {page.kind === 'studio' && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          Visitors see this studio page&apos;s earlier content until studio pages move to this editor.
        </div>
      )}
      <LandingPageSettingsForm
        key={page.id}
        page={page}
        studios={studiosFor(loaded.studios, canEdit)}
        canEdit={canEdit}
        availableBookingTypes={eventTypesRes.data || []}
        availableEvents={eventsRes.data || []}
        brand={brand}
      />
    </div>
  )
}
