// POST /api/admin/tv-displays/upload/finalise
//
// TVUPLOAD.1 (C93) — step 3 of the phone's TV image upload (the flow is in
// src/lib/tv-upload.js). The device has put the bytes at a slot minted by
// …/upload/sign; this confirms the object before the phone points a TV or a
// template at it. The path must be a slot for THIS studio and kind, and the
// size and type are read back from Storage, never taken from the caller. An
// object that breaks the TV image rules is removed.
//
// Body: { kind: 'content'|'template', location_id?, path }
// → { success: true, path }   (tv_content.source_ref / tv_templates.base_image_path)

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { isTvUploadPath, checkTvImage, TV_UPLOAD_KINDS } from '@/lib/tv-upload'
import { tvUploadAnywhereGate, tvUploadLocationGate } from '@/lib/tv-upload-gate'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TvUploadFinaliseSchema = z.object({
  kind: z.enum(TV_UPLOAD_KINDS).default('content'),
  location_id: uuidLike.optional(),
  path: z.string().min(1).max(500),
})

export async function POST(request) {
  const user = await getCurrentUser()
  const coarse = tvUploadAnywhereGate(user)
  if (coarse) return coarse

  const validation = await validateBody(request, TvUploadFinaliseSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const locationId = body.location_id || user.activeLocation?.id
  const gate = tvUploadLocationGate(user, locationId)
  if (gate) return gate

  if (!isTvUploadPath(body.path, locationId, body.kind)) {
    return NextResponse.json({ success: false, error: 'That is not an upload slot for this studio.' }, { status: 400 })
  }

  const db = createServerClient()
  const bucket = db.storage.from('tv-content')
  const slash = body.path.lastIndexOf('/')
  const folder = body.path.slice(0, slash)
  const name = body.path.slice(slash + 1)
  const { data: listed, error: listErr } = await bucket.list(folder, { search: name })
  if (listErr) {
    logWarn('tv-upload', 'stored image read failed', { error: listErr.message })
    return NextResponse.json({ success: false, error: `Could not check the upload: ${listErr.message}` }, { status: 500 })
  }
  const hit = (listed || []).find((o) => o?.name === name)
  if (!hit) {
    return NextResponse.json({ success: false, error: 'The image did not finish uploading. Try again.' }, { status: 400 })
  }

  const stored = checkTvImage({ mime: hit.metadata?.mimetype, size: hit.metadata?.size })
  if (!stored.ok) {
    try {
      const { error: rmErr } = await bucket.remove([body.path])
      if (rmErr) logWarn('tv-upload', 'refused image not removed', { error: rmErr.message })
    } catch (e) {
      logWarn('tv-upload', 'refused image not removed', { error: e?.message })
    }
    return NextResponse.json({ success: false, error: stored.error }, { status: 400 })
  }

  return NextResponse.json({ success: true, path: body.path })
}
