// POST /api/whatsapp/templates/upload-media/sign
//
// Step 1 of the template-media upload flow (see src/lib/template-media.js
// header for the why): validates the prospective file against Meta's caps,
// mints a storage path, and returns a Supabase signed-upload token so the
// BROWSER uploads the bytes directly to the public 'whatsapp-templates'
// bucket. The file never transits Vercel — serverless request bodies are
// capped at ~4.5 MB, which is what 413'd every real video upload.
//
// Only the path/token are minted here — the server picks the path
// (location-folder + UUID), so a caller can't choose arbitrary keys.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateTemplateMedia } from '@/lib/template-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SignSchema = z.object({
  format: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().positive(),
  file_name: z.string().min(1).max(300),
  location_id: uuidLike.optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const validation = await validateBody(request, SignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const check = validateTemplateMedia({
    format: body.format,
    mime: body.mime,
    size: body.size,
    fileName: body.file_name,
  })
  if (!check.ok) {
    return NextResponse.json({ success: false, error: check.error }, { status: 400 })
  }

  const locationId = body.location_id || user.activeLocation?.id
  const guard = locationId ? assertLocationAccess(user, locationId) : null
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // UUID-based path so the public URL is effectively unguessable; folder
  // per location for cleanup. Same scheme the old in-route upload used.
  const storagePath = `${locationId || 'global'}/${randomUUID()}${check.ext}`

  const db = createServerClient()
  const { data, error } = await db.storage
    .from('whatsapp-templates')
    .createSignedUploadUrl(storagePath)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not create upload URL: ${error?.message || 'no token returned'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    path: storagePath,
    token: data.token,
  })
}
