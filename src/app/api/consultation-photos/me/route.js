// GET /api/consultation-photos/me — the member's own progress photos (champ-app).
//
// Customer-authed via the member's Supabase JWT (resolveCustomerContact). The
// `consultation-photos` bucket is PRIVATE and has no member storage-RLS, so the
// member's own client cannot read the files — this service-role route mints
// short-lived signed URLs for the member's own rows and returns them.
//
// Read-only. The member-upload path is a separate (native-release) phase.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SIGNED_URL_TTL = 600 // 10 minutes

export async function GET(request) {
  const db = createServerClient()

  const { contact, error } = await resolveCustomerContact(request, { db })
  if (error) {
    return NextResponse.json({ success: false, error }, { status: error === 'no_contact' ? 409 : 401 })
  }

  const { data: rows, error: qErr } = await db
    .from('consultation_photos')
    .select('id, storage_path, taken_at, label, caption, source')
    .eq('contact_id', contact.id)
    .order('taken_at', { ascending: false })

  if (qErr) {
    return NextResponse.json({ success: false, error: qErr.message }, { status: 500 })
  }

  // Batch-sign every path in one call (the bucket is private).
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean)
  let signedByPath = {}
  if (paths.length) {
    const { data: signed } = await db.storage
      .from('consultation-photos')
      .createSignedUrls(paths, SIGNED_URL_TTL)
    signedByPath = Object.fromEntries((signed || []).map((s) => [s.path, s.signedUrl]))
  }

  const items = (rows || []).map((r) => ({
    id: r.id,
    taken_at: r.taken_at,
    label: r.label,
    caption: r.caption,
    source: r.source,
    url: signedByPath[r.storage_path] || null,
  }))

  return NextResponse.json({ success: true, data: items })
}
