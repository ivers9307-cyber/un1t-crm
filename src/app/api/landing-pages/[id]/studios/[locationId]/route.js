// PAGES.1 — PUT /api/landing-pages/[id]/studios/[locationId]: one studio's
// half of a page's offer (`offer`: plan ids, keywords, price), its
// attribution, whether the page is switched on there, and its picker order.
//
// A page outside canViewPage, and a studio that is not one of the page's own
// rows (on a one-studio page, a studio page included: anything but its
// primary), are 404s. The write is canEditPage's
// (403): on an all-studios page that is an organisation admin, so a studio
// manager is refused even on their own studio's row (spec §8). `offer` is parsed with the page's type schema
// (studioOfferSchema, strict: an unknown key is a 400 with the issues). A page
// with no offer has no studio half (400 no_offer). UN1TWRITE.18: a priced
// class_funnel at a un1t.online studio is refused (400): anything paid there
// goes through un1t.online checkout (the row's locations embed carries the
// studio's membership_source, so no extra read; a row without the embed is a
// 503, never a priced save). Answers the saved row and its
// readiness (studioRowReadiness, the list's and the publish gate's rule).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { landingPageStudioSchema } from '@/lib/landing-page-schemas'
import { OFFER_BLOCK_TYPE, studioOfferSchema } from '@/lib/landing-page-offers'
import {
  loadViewablePage, canEditPage, studioRowReadiness, studioRowView, studioPublicPath, saveStudioRow, PageReadError,
} from '@/lib/landing-pages'
import { logError } from '@/lib/log'

const UN1T_PAID_INTRO_REFUSAL = 'Paid intros are not available at a un1t.online studio: anything paid goes through un1t.online checkout.'
const embeddedOne = (v) => (Array.isArray(v) ? v[0] || null : v || null)

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  const { id, locationId } = await params
  const db = createServerClient()

  try {
    const loaded = await loadViewablePage(db, user, id)
    if (!loaded) return fail(404, 'not_found')
    const { page, studios } = loaded
    if (!canEditPage(user, page)) return fail(403, 'You can view this page but not edit its studios')

    const validation = await validateBody(request, landingPageStudioSchema)
    if (!validation.ok) return validation.response
    const body = validation.data

    const blockType = OFFER_BLOCK_TYPE[page.offer_type]
    if (!blockType) return fail(400, 'no_offer')
    const row = studios.find((r) => r.location_id === locationId)
    if (!row) return fail(404, 'not_found')

    const offer = studioOfferSchema(blockType).safeParse(body.offer)
    if (!offer.success) {
      const issues = offer.error.issues.map((i) => ({ path: ['offer', ...i.path].join('.'), message: i.message }))
      return fail(400, 'Invalid request body', { issues })
    }
    if (blockType === 'class_funnel' && Number(offer.data.price_cents) > 0) {
      // Fail closed: a studio whose row came back without its locations
      // embed cannot be judged, so a priced save waits (503, nothing written).
      const loc = embeddedOne(row.locations)
      if (!loc) {
        logError('landing-pages', 'studio unreadable for the paid intro check', { pageId: id, locationId })
        return fail(503, 'unavailable')
      }
      if (loc.membership_source === 'un1t_online') return fail(400, UN1T_PAID_INTRO_REFUSAL)
    }

    const patch = { enabled: body.enabled, offer: offer.data, attribution: body.attribution, updated_by: user.id }
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order
    const saved = await saveStudioRow(db, { pageId: page.id, locationId, patch })
    if (!saved.ok) {
      if (saved.reason === 'gone') return fail(404, 'not_found')
      logError('landing-pages', 'studio row save failed', { pageId: id, locationId, code: saved.error?.code ?? null })
      return fail(500, 'The studio could not be saved')
    }
    // The saved columns over the loaded row, which carries the locations embed.
    const merged = { ...row, ...saved.row }
    const publicPath = await studioPublicPath(db, locationId)
    const readiness = await studioRowReadiness(db, { page, row: merged, publicPath })
    return NextResponse.json({ success: true, data: { row: studioRowView(merged, { publicPath }), readiness } })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'studio row read failed', { pageId: id, locationId, code: err.cause?.code ?? null })
    return fail(503, 'unavailable')
  }
}
