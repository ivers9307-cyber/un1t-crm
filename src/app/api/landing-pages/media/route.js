// MEDIALIB.1 — GET /api/landing-pages/media?kind=video|image
//
// The page editor's "Choose existing" list: every video or image already
// uploaded for the pages the caller may view (src/lib/landing-media-library.js
// decides the scope: canViewPage over landing_pages, then the `pages/<id>/`
// and legacy `landing-page/<studio>/` folders of the 'branding' bucket).
// Service role: a read of the bucket, never a write, so the bucket guard
// (tests/branding-bucket-guard.test.js) keeps its writer list.
//
// Answers { success, data: { items } }; a caller who may view no page gets
// an empty list, a bad `kind` 400, a failed read 503 (never a shorter list).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listLandingMediaForUser, MEDIA_KINDS } from '@/lib/landing-media-library'
import { PageReadError } from '@/lib/landing-pages'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error) => NextResponse.json({ success: false, error }, { status })

// Any signed-in caller; listLandingMediaForUser scopes the list to the pages
// they may view (canViewPage), so withAuth only signs them in.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const kindRaw = new URL(request.url).searchParams.get('kind')
  const kind = kindRaw ? kindRaw : null
  if (kind && !MEDIA_KINDS.includes(kind)) return fail(400, 'kind must be video or image')

  try {
    const data = await listLandingMediaForUser(db, user, { kind })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('landing-pages', 'media library unreadable', { code: err.cause?.code ?? null, message: err.message })
    return fail(503, 'unavailable')
  }
})
