// POST /api/admin/tv-displays/upload/sign
//
// TVUPLOAD.1 (C93) — step 1 of the phone's TV image upload (the flow is in
// src/lib/tv-upload.js). The phone's multipart post to
// /api/admin/tv-displays/upload carries a `{uri}` file part, which has not
// left the phone since Expo SDK 57; the bytes now go straight to Storage
// against the slot this route mints. The server picks the path (the TV's
// studio + a UUID), so a caller cannot choose where the bytes land, and the
// token authorises exactly that one path (the 'tv-content' bucket has no
// client policy, mig 671). The declared type and size are checked here to
// save a pointless upload; …/finalise re-checks what Storage actually holds.
//
// Body: { kind: 'content'|'template', location_id?, file_name, mime, size }
// → { success: true, path, token }

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { buildTvUploadPath, checkTvImage, TV_UPLOAD_KINDS } from '@/lib/tv-upload'
import { tvUploadAnywhereGate, tvUploadLocationGate } from '@/lib/tv-upload-gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TvUploadSignSchema = z.object({
  kind: z.enum(TV_UPLOAD_KINDS).default('content'),
  location_id: uuidLike.optional(),
  file_name: z.string().max(300).optional(),
  mime: z.string().min(1).max(100),
  size: z.number().int().positive(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  const coarse = tvUploadAnywhereGate(user)
  if (coarse) return coarse

  const validation = await validateBody(request, TvUploadSignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Same default as the multipart route: the TV's studio, else the active one.
  const locationId = body.location_id || user.activeLocation?.id
  const gate = tvUploadLocationGate(user, locationId)
  if (gate) return gate

  const check = checkTvImage({ mime: body.mime, size: body.size })
  if (!check.ok) return NextResponse.json({ success: false, error: check.error }, { status: 400 })

  const path = buildTvUploadPath({ locationId, kind: body.kind, fileName: body.file_name, id: randomUUID() })
  const db = createServerClient()
  const { data, error } = await db.storage.from('tv-content').createSignedUploadUrl(path)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not start the upload: ${error?.message || 'no token returned'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, path, token: data.token })
}
