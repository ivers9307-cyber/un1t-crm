// POST /api/events/[id]/video/signed-upload — CHARITY.14: mint a one-shot
// Supabase Storage signed upload URL so the event form can PUT a charity-day
// video STRAIGHT to the public 'branding' bucket, bypassing the ~4.5MB Vercel
// request-body cap (the same shape as /api/landing-page-settings/media/
// signed-upload). The file lands under race-video/<event id>/<uuid>.<ext>;
// the form then saves the returned public `url` as charity.video_file_url,
// which the settings schema only accepts for that path.
//
// Gates mirror /api/events/[id]/hero: a signed-in user holding `races` at the
// event's studio (404, never 403, for an event at another studio). The bucket's
// own allowed_mime_types + file_size_limit (src/lib/branding-media.js, 200MB)
// are the real ceiling on the direct upload; the token authorises it, not RLS
// (mig 675, BRANDINGBUCKET.1).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// video/quicktime is the uncompressed fallback when in-browser transcoding
// cannot run (see src/lib/landing-media-upload.js); it plays in Safari and
// most Chromium builds.
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }

const Body = z.object({ content_type: z.string().max(100) })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }
  if (!uuidLike.safeParse(params.id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const ext = VIDEO_EXT[validation.data.content_type]
  if (!ext) {
    return NextResponse.json({ success: false, error: 'Unsupported video type. Use MP4, WebM, or MOV.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, race.location_id, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const path = `race-video/${race.id}/${randomUUID()}.${ext}`
  const { data, error } = await db.storage.from('branding').createSignedUploadUrl(path)
  if (error || !data?.token) {
    return NextResponse.json({ success: false, error: error?.message || 'Could not create upload URL.' }, { status: 400 })
  }
  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  return NextResponse.json({ success: true, path: data.path, token: data.token, url: urlData.publicUrl })
}
