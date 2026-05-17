// GET /api/public/bca/[token]/file/[slug]
//
// Public tracking-redirect for one source document on the
// /bca/<token> page. Validates token + expiry + slug, looks up the
// stored documents JSONB to find the file's storage path, logs a
// 'download_file' event (with the slug), redirects to a fresh 1h
// signed URL.
//
// Slug is constrained to /^doc_\d{2}$/ (matches BCA_STORAGE) so the
// param can't escape to arbitrary storage paths.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { BCA_STORAGE } from '@/lib/bca'
import { recordBcaDownload, getClientIp } from '@/lib/bca-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  if (!/^doc_\d{2}$/.test(params.slug)) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: row } = await db
    .from('car_bca_submissions')
    .select('id, documents, download_expires_at')
    .eq('download_token', params.token)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expired = !row.download_expires_at
    || new Date(row.download_expires_at).getTime() <= Date.now()
  if (expired) return NextResponse.json({ error: 'Download window expired' }, { status: 410 })

  const docs = Array.isArray(row.documents) ? row.documents : []
  const doc = docs.find(d => d?.slug === params.slug)
  if (!doc || !doc.storage_path) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  const { data: signed } = await db.storage
    .from(BCA_STORAGE.bucket)
    .createSignedUrl(doc.storage_path, 3600)
  if (!signed?.signedUrl) {
    return NextResponse.json({ error: 'Failed to sign download URL' }, { status: 500 })
  }

  recordBcaDownload(db, row.id, {
    type: 'file',
    slug: params.slug,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
  }).catch(() => {})

  return NextResponse.redirect(signed.signedUrl, 302)
}
