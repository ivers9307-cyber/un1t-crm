// PAGES.1 — POST /api/landing-pages/[id]/publish: draft, live, coming_soon or
// retired.
//
// A page outside canViewPage is a 404; canEditPage decides the write (403).
// A studio page publishes like any one-studio page but is never retired
// (400 studio_page): a studio's main page is unpublished (draft), and its slug
// stays the studio's public path. Live on a page
// that sells something needs a ready offer (studioRowReadiness, the same rule
// as the list's chip): on a one-studio page its primary row, switched on
// (else 409 not_ready naming it, `switched_off` when it is off); on an
// all-studios page at least one switched-on studio (else 409 not_ready naming
// each switched-on studio and why). Retired needs a same-site redirect_to
// (the schema refuses anything else). Going live stamps chrome.was_live, which makes a later slug
// change leave a redirect behind.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { landingPagePublishSchema } from '@/lib/landing-page-schemas'
import { OFFER_BLOCK_TYPE } from '@/lib/landing-page-offers'
import {
  loadViewablePage, canEditPage, studioRowReadiness, studioRowView, updatePageRow, PageReadError,
} from '@/lib/landing-pages'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  const { id } = await params
  const db = createServerClient()

  try {
    const loaded = await loadViewablePage(db, user, id)
    if (!loaded) return fail(404, 'not_found')
    const { page, studios } = loaded
    if (!canEditPage(user, page)) return fail(403, 'You can view this page but not publish it')

    const validation = await validateBody(request, landingPagePublishSchema)
    if (!validation.ok) return validation.response
    const { publish_state: state, redirect_to: redirectTo } = validation.data

    if (state === 'retired' && page.kind === 'studio') return fail(400, 'studio_page')

    if (state === 'retired' && !redirectTo) return fail(400, 'redirect_required')

    if (state === 'live' && OFFER_BLOCK_TYPE[page.offer_type]) {
      // A one-studio page sells at its primary only, so that row alone is
      // judged: switched on and ready. An all-studios page needs any one.
      if (page.scope === 'one') {
        const row = studios.find((r) => r.location_id === page.primary_location_id) || null
        const readiness = row?.enabled ? await studioRowReadiness(db, { page, row }) : null
        if (!readiness?.ready) {
          return fail(409, 'not_ready', {
            studios: row ? [{ location_id: row.location_id, name: studioRowView(row).name, reason: readiness?.reason || 'switched_off' }] : [],
          })
        }
      } else {
        const enabled = studios.filter((r) => r.enabled)
        const judged = await Promise.all(enabled.map(async (row) => ({ row, readiness: await studioRowReadiness(db, { page, row }) })))
        if (!judged.some((j) => j.readiness.ready)) {
          return fail(409, 'not_ready', {
            studios: judged.map(({ row, readiness }) => ({ location_id: row.location_id, name: studioRowView(row).name, reason: readiness.reason })),
          })
        }
      }
    }

    const patch = {
      publish_state: state,
      redirect_to: state === 'retired' ? redirectTo : null,
      updated_by: user.id,
    }
    if (state === 'live') patch.chrome = { ...(page.chrome || {}), was_live: true }
    const saved = await updatePageRow(db, page.id, patch)
    if (!saved.ok) {
      if (saved.reason === 'gone') return fail(404, 'not_found')
      logError('landing-pages', 'publish failed', { pageId: id, state, code: saved.error?.code ?? null })
      return fail(500, 'The page could not be published')
    }
    return NextResponse.json({ success: true, data: saved.page })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'publish read failed', { pageId: id, code: err.cause?.code ?? null })
    return fail(503, 'unavailable')
  }
}
