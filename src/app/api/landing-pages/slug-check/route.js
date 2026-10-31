// PAGES.1 — GET /api/landing-pages/slug-check?slug=: is this path free for a
// new page? Answers for the caller's ACTIVE organisation only (a `?org=` is
// never honoured, so another tenant's slugs cannot be probed):
// { available, problem: 'reserved' | 'invalid' | 'taken' | null }. The create
// and rename routes are the authority; this is the form's pre-check.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { activeOrganizationId } from '@/lib/org-admin'
import { slugProblem, normaliseSlug } from '@/lib/page-slug'
import { slugTakenInOrg, PageReadError } from '@/lib/landing-pages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error) => NextResponse.json({ success: false, error }, { status })
const answer = (available, problem) => NextResponse.json({ success: true, data: { available, problem } })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')
  const orgId = activeOrganizationId(user)
  if (!orgId) return fail(400, 'no_organisation')

  const raw = new URL(request.url).searchParams.get('slug') || ''
  const problem = slugProblem(raw)
  if (problem) return answer(false, problem)
  try {
    const taken = await slugTakenInOrg(createServerClient(), { orgId, slug: normaliseSlug(raw) })
    return taken ? answer(false, 'taken') : answer(true, null)
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    return fail(503, 'unavailable')
  }
}
