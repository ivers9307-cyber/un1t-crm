// POST /api/invoices/upload-sign
//
// Step 1 of the contractor-invoice PDF upload. Vercel caps serverless
// request bodies at ~4.5 MB, so the advertised 10 MB PDF cap was
// physically impossible through the multipart POST /api/invoices —
// anything over the platform cap died with a plain-text 413 before the
// route ran (the exact bug class fixed for WhatsApp template media in
// WA-TMPL-UPLOAD.1). The bytes must bypass Vercel:
//
//   1. This route validates the prospective file, mints the storage
//      path (buildPdfPath — the contractor's own folder) and returns a
//      Supabase signed-upload token for the PRIVATE contractor-invoices
//      bucket.
//   2. The client uploads the PDF directly to storage with the token.
//   3. POST /api/invoices (JSON mode) verifies the object and inserts
//      the row.
//
// Same contractor gate as the submit route — only contractor accounts
// ever mint upload slots.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { periodForMonth, buildPdfPath } from '@/lib/contractor-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'contractor-invoices'
const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10 MB — keep in lockstep with POST /api/invoices

const SignSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM'),
  size: z.number().int().positive(),
  mime: z.string().min(1),
  file_name: z.string().min(1).max(200),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.employment_type !== 'contractor') {
    return NextResponse.json(
      { success: false, error: 'Only contractor accounts can submit invoices.' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, SignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (body.mime !== 'application/pdf') {
    return NextResponse.json({ success: false, error: 'Only PDF files are accepted.' }, { status: 400 })
  }
  if (body.size > MAX_PDF_BYTES) {
    return NextResponse.json({ success: false, error: 'PDF must be 10 MB or less.' }, { status: 400 })
  }

  let period
  try {
    period = periodForMonth(body.month)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 400 })
  }

  const storagePath = buildPdfPath({
    contractorId: user.id,
    periodStart: period.period_start,
    originalFilename: body.file_name,
  })

  const db = createServerClient()
  const { data, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(storagePath)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not create upload URL: ${error?.message || 'no token returned'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, path: storagePath, token: data.token })
}
