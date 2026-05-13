// TV.1 — public read endpoint for the /tv page.
//
// GET /api/tv/[token]/content
//
// No auth header — the token IS the auth. The page polls this
// every ~3s and re-renders when pushed_at changes. Service-role
// supabase client bypasses RLS (the table's RLS is for the
// authenticated admin path; the TV itself has no session).
//
// Response shape:
//   200 { display: { id, label, location_id }, content: { ... } | null }
//   404 { error: 'invalid_token' }

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET(_request, { params }) {
  const { token } = params
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 400 })

  const db = createServerClient()

  // 1. Resolve the token → display
  const { data: display, error: dErr } = await db
    .from('tv_displays')
    .select('id, label, location_id, active')
    .eq('token', token)
    .single()
  if (dErr || !display || !display.active) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 404 })
  }

  // 2. Pull the current content row (or null = idle).
  const { data: content } = await db
    .from('tv_content')
    .select('source_type, source_ref, label, pushed_at, triggered_by')
    .eq('tv_display_id', display.id)
    .maybeSingle()

  // Public bucket URL for storage-backed content. We resolve
  // server-side so the page doesn't need to know the Supabase
  // project URL or build paths.
  let resolvedUrl = null
  if (content?.source_type === 'storage') {
    resolvedUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/tv-content/${content.source_ref}`
  } else if (content?.source_type === 'url') {
    resolvedUrl = content.source_ref
  }

  return NextResponse.json({
    display: { id: display.id, label: display.label, location_id: display.location_id },
    content: content
      ? {
          source_type: content.source_type,
          resolved_url: resolvedUrl,
          label: content.label,
          pushed_at: content.pushed_at,
          triggered_by: content.triggered_by,
        }
      : null,
  })
}
