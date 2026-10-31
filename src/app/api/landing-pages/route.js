// PAGES.1 — /api/landing-pages: GET the Pages list, POST a new campaign page.
//
// Service role (no RLS: landing_pages and landing_page_studios are closed to
// every client session, mig 792), so access is decided here:
//   - GET: listPagesForUser reads the pages of the caller's organisations and
//     keeps those canViewPage admits; each carries can_edit (canEditPage).
//   - POST: scope 'one' needs the landing_page permission at
//     primary_location_id; scope 'all' needs an organisation admin of the
//     caller's active organisation. A studio page is never created here.
//   A slug is refused as `reserved` / `invalid` (400) or `taken` (409). A
//   start page the caller cannot view is a 404, so page ids cannot be probed.
// Design: docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md §7-8.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { isOrgAdmin } from '@/lib/org-admin'
import { validateBody } from '@/lib/validate'
import { landingPageCreateSchema } from '@/lib/schemas'
import { slugProblem } from '@/lib/page-slug'
import { resolveLocationBrand, resolveOrgChrome } from '@/lib/host-brand'
import { listPagesForUser, createPage, loadViewablePage, PageReadError } from '@/lib/landing-pages'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })
const unavailable = () => fail(503, 'unavailable')

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  try {
    const pages = await listPagesForUser(createServerClient(), user)
    return NextResponse.json({ success: true, data: pages })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'pages list unreadable', { code: err.cause?.code ?? null })
    return unavailable()
  }
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')

  const validation = await validateBody(request, landingPageCreateSchema)
  if (!validation.ok) return validation.response
  const input = validation.data
  const db = createServerClient()

  let orgId
  if (input.scope === 'one') {
    if (!input.primary_location_id) return fail(400, 'primary_location_required')
    if (!hasPermissionForLocation(user, input.primary_location_id, 'landing_page')) return fail(403, 'Landing pages are not enabled for your role at this studio')
    const { data: loc, error } = await db
      .from('locations')
      .select('id, organization_id')
      .eq('id', input.primary_location_id)
      .maybeSingle()
    if (error) return unavailable()
    if (!loc?.organization_id) return fail(404, 'not_found')
    orgId = loc.organization_id
  } else {
    orgId = user.activeOrganization?.id || null
    if (!orgId || !isOrgAdmin(user, orgId)) return fail(403, 'Only an organisation admin can make an all-studios page')
  }

  const problem = slugProblem(input.slug)
  if (problem) return fail(400, problem)

  try {
    let startFrom = null
    if (input.start_from_page_id) {
      const loaded = await loadViewablePage(db, user, input.start_from_page_id)
      if (!loaded) return fail(404, 'not_found')
      startFrom = loaded.page
    }
    const brand = input.scope === 'one'
      ? (await resolveLocationBrand({ locationId: input.primary_location_id, db })).companyName
      : (await resolveOrgChrome({ orgId, db })).companyName
    const created = await createPage(db, {
      input: { ...input, primary_location_id: input.scope === 'one' ? input.primary_location_id : null },
      orgId,
      userId: user.id,
      brand: brand || '',
      startFrom,
    })
    if (!created.ok) {
      if (created.reason === 'taken') return fail(409, 'taken')
      logError('landing-pages', 'page create failed', { orgId, code: created.error?.code ?? null })
      return fail(500, 'The page could not be created')
    }
    return NextResponse.json({ success: true, data: created.page }, { status: 201 })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'page create read failed', { orgId, code: err.cause?.code ?? null })
    return unavailable()
  }
}
