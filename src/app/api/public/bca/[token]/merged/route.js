// GET /api/public/bca/[token]/merged
//
// Public tracking-redirect for the merged-PDF download from the
// /bca/<token> landing page. Validates token, validates not-expired,
// logs a 'download_merged' event + bumps rollup counts, mints a
// fresh 1h Supabase signed URL, returns a 302 to it.
//
// Why this hop rather than putting the signed URL straight in the
// page: gives us a tracking point. Without it we can know the page
// was rendered but not whether anyone actually downloaded.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { BCA_STORAGE } from '@/lib/bca'
import { recordBcaDownload, getClientIp } from '@/lib/bca-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const db = createServerClient()
  const { data: row } = await db
    .from('car_bca_submissions')
    .select('id, merged_pdf_path, download_expires_at')
    .eq('download_token', params.token)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expired = !row.download_expires_at
    || new Date(row.download_expires_at).getTime() <= Date.now()
  if (expired) return NextResponse.json({ error: 'Download window expired' }, { status: 410 })

  if (!row.merged_pdf_path) {
    return NextResponse.json({ error: 'No merged PDF on file' }, { status: 404 })
  }

  const { data: signed } = await db.storage
    .from(BCA_STORAGE.bucket)
    .createSignedUrl(row.merged_pdf_path, 3600)
  if (!signed?.signedUrl) {
    return NextResponse.json({ error: 'Failed to sign download URL' }, { status: 500 })
  }

  // Best-effort tracking — never block the download on an event-log
  // write. Errors here would hide the actual file from BCA.
  recordBcaDownload(db, row.id, {
    type: 'merged',
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
  }).catch(() => {})

  return NextResponse.redirect(signed.signedUrl, 302)
}
