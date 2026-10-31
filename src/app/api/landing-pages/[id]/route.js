// PAGES.1 — /api/landing-pages/[id]: GET one page with its studio rows, PUT
// its title, slug, blocks and chrome.
//
// Service role, so access is decided here: a page outside canViewPage is a
// 404 (unknown and hidden ids answer alike), a page the caller may view but
// not edit (canEditPage) is a 403 on PUT, and on GET gets no studio half
// and the blocks through clientSafeBlocks. kind, scope, primary_location_id
// and offer_type are not updatable (the schema is strict). Blocks are stored
// without any studio half (pageBlocksToStore); chrome.was_live is kept as
// stored (publish owns it). A slug change on a page that has been live leaves
// a retired page at the old slug that redirects to the new one (renameSlug).
// A studio page (kind 'studio') saves like any one-studio page, its offer
// block kept wherever it sits (pageBlocksToStore), except that its slug is
// never renamed (400 studio_page, nothing written): the slug is the studio's
// public path, which the chooser's tile order, trial-studios.js and the
// per-studio pixel key on.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { landingPageUpdateSchema } from '@/lib/landing-page-schemas'
import { clientSafeBlocks } from '@/lib/landing-page-blocks'
import { normaliseSlug, slugProblem } from '@/lib/page-slug'
import {
  loadViewablePage, canEditPage, studioRowReadiness, studioRowView, studioPublicPath, pageBlocksToStore,
  mergedChrome, updatePageRow, renameSlug, PageReadError,
} from '@/lib/landing-pages'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  const { id } = await params
  const db = createServerClient()
  try {
    const loaded = await loadViewablePage(db, user, id)
    if (!loaded) return fail(404, 'not_found')
    const { page, studios } = loaded
    const canEdit = canEditPage(user, page)
    // The studio half (plan ids, product ids, prices, promo keys, tags) goes
    // to an editor only: a read-only viewer gets the switch and the readiness
    // (EDITGATE.1 parity: the ?edit=1 preview withholds the same keys).
    const ordered = studios.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    // One path read per studio, shared by the view (the tag default) and the readiness.
    const rows = await Promise.all(ordered.map(async (row) => {
      const publicPath = await studioPublicPath(db, row.location_id)
      const { offer, attribution, ...view } = studioRowView(row, { publicPath })
      return {
        ...view,
        ...(canEdit ? { offer, attribution } : {}),
        readiness: await studioRowReadiness(db, { page, row, publicPath }),
      }
    }))
    // A non-editor's blocks lose the operator keys a backfilled block may
    // still carry (EDITGATE.1, as the [id] server page does).
    const pageOut = canEdit ? page : { ...page, blocks: clientSafeBlocks(page.blocks) }
    return NextResponse.json({ success: true, data: { page: pageOut, studios: rows, can_edit: canEdit } })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'page unreadable', { pageId: id, code: err.cause?.code ?? null })
    return fail(503, 'unavailable')
  }
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  const { id } = await params
  const db = createServerClient()

  let loaded
  try {
    loaded = await loadViewablePage(db, user, id)
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'page unreadable on save', { pageId: id, code: err.cause?.code ?? null })
    return fail(503, 'unavailable')
  }
  if (!loaded) return fail(404, 'not_found')
  const { page } = loaded
  if (!canEditPage(user, page)) return fail(403, 'You can view this page but not edit it')

  const validation = await validateBody(request, landingPageUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const newSlug = body.slug !== undefined ? normaliseSlug(body.slug) || body.slug : page.slug
  if (page.kind === 'studio' && newSlug !== page.slug) return fail(400, 'studio_page')

  const patch = { updated_by: user.id }
  if (body.title !== undefined) patch.title = body.title
  if (body.blocks !== undefined) {
    const stored = pageBlocksToStore(page, body.blocks)
    if (!stored.ok) return fail(400, stored.error)
    patch.blocks = stored.blocks
  }
  if (body.chrome !== undefined) patch.chrome = mergedChrome(page.chrome, body.chrome)

  if (newSlug !== page.slug) {
    const problem = slugProblem(newSlug)
    if (problem) return fail(400, problem)
    const renamed = await renameSlug(db, { page, slug: newSlug, patch, userId: user.id })
    if (!renamed.ok && renamed.reason === 'retire_failed') {
      // The redirect for the old slug could not be written, so the rename was undone.
      logError('landing-pages', 'rename undone: the old slug\'s redirect could not be written', { pageId: id, code: renamed.error?.code ?? null })
      return fail(500, 'The page could not be renamed')
    }
    if (!renamed.ok) return saveFailure(renamed, id)
    if (renamed.retiredError) {
      logError('landing-pages', 'page renamed but the old slug has no redirect', { pageId: id, code: renamed.retiredError.code ?? null })
      logError('landing-pages', 'rename could not be undone', { pageId: id, code: renamed.rollbackError?.code ?? null })
      return fail(500, 'The page was renamed, but its old address could not be redirected', { data: renamed.page })
    }
    return NextResponse.json({ success: true, data: renamed.page })
  }

  const saved = await updatePageRow(db, page.id, patch)
  if (!saved.ok) return saveFailure(saved, id)
  return NextResponse.json({ success: true, data: saved.page })
}

function saveFailure(result, pageId) {
  if (result.reason === 'taken') return fail(409, 'taken')
  if (result.reason === 'gone') return fail(404, 'not_found')
  logError('landing-pages', 'page save failed', { pageId, code: result.error?.code ?? null })
  return fail(500, 'The page could not be saved')
}
