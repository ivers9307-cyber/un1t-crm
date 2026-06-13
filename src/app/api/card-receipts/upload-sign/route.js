// POST /api/card-receipts/upload-sign
//
// Step 1 of the company-card receipt upload (SPEND.P3). Mirrors the
// contractor-invoice upload-sign: Vercel caps serverless request bodies
// at ~4.5 MB, so the receipt bytes bypass Vercel by uploading directly
// to Supabase Storage with a signed token:
//
//   1. This route validates the prospective file, mints the storage
//      path (buildReceiptPath — the submitter's own folder) and returns
//      a signed-upload token for the PRIVATE company-card-receipts bucket.
//   2. The client uploads the receipt directly to storage with the token.
//   3. POST /api/card-receipts (finalise) verifies the object + inserts.
//
// Gated by the `card_receipts` permission — only card holders mint slots.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  buildReceiptPath, RECEIPT_MIME_TYPES, CARD_RECEIPTS_BUCKET, MAX_RECEIPT_BYTES,
} from '@/lib/card-receipts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SignSchema = z.object({
  size: z.number().int().positive(),
  mime: z.string().min(1),
  file_name: z.string().min(1).max(200),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'card_receipts')) {
    return NextResponse.json(
      { success: false, error: 'You do not have permission to submit company-card receipts.' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, SignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (!RECEIPT_MIME_TYPES.includes(body.mime)) {
    return NextResponse.json({ success: false, error: 'Only a PDF or photo (JPG, PNG, HEIC) is accepted.' }, { status: 400 })
  }
  if (body.size > MAX_RECEIPT_BYTES) {
    return NextResponse.json({ success: false, error: 'File must be 10 MB or less.' }, { status: 400 })
  }

  // The path date is just for bucket organisation — the real purchase
  // date is captured on the row at finalise. Use the server date so the
  // sign request doesn't need it.
  const today = new Date().toISOString().slice(0, 10)
  const storagePath = buildReceiptPath({
    submitterId: user.id,
    purchaseDate: today,
    originalFilename: body.file_name,
  })

  const db = createServerClient()
  const { data, error } = await db.storage
    .from(CARD_RECEIPTS_BUCKET)
    .createSignedUploadUrl(storagePath)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not create upload URL: ${error?.message || 'no token returned'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, path: storagePath, token: data.token })
}
