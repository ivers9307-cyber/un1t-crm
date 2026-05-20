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
//   200 { display: { id, label, location_id, rotation }, content: { ... } | null }
//   404 { error: 'invalid_token' }
//
// content.source_type 'template' (TV-TEMPLATE.1) carries an extra
// `template` field: { zones, values } — the base image arrives as
// the usual resolved_url; the client overlays the zone text.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const { token } = params
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 400 })

  const db = createServerClient()

  // 1. Resolve the token → display
  const { data: display, error: dErr } = await db
    .from('tv_displays')
    .select('id, label, location_id, active, rotation')
    .eq('token', token)
    .single()
  if (dErr || !display || !display.active) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 404 })
  }

  // 2. Pull the current content row (or null = idle).
  const { data: content } = await db
    .from('tv_content')
    .select('source_type, source_ref, label, pushed_at, triggered_by, template_values')
    .eq('tv_display_id', display.id)
    .maybeSingle()

  const bucketUrl = (path) =>
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/tv-content/${path}`

  // Public bucket URL for storage-backed content. We resolve
  // server-side so the page doesn't need to know the Supabase
  // project URL or build paths.
  let resolvedUrl = null
  let template = null
  if (content?.source_type === 'storage') {
    resolvedUrl = bucketUrl(content.source_ref)
  } else if (content?.source_type === 'url') {
    resolvedUrl = content.source_ref
  } else if (content?.source_type === 'template') {
    // TV-TEMPLATE.1 — source_ref is the tv_templates.id. Resolve
    // the base image + fixed zones; template_values holds the text.
    const { data: tpl } = await db
      .from('tv_templates')
      .select('base_image_path, zones')
      .eq('id', content.source_ref)
      .maybeSingle()
    if (tpl) {
      resolvedUrl = bucketUrl(tpl.base_image_path)
      template = {
        zones: Array.isArray(tpl.zones) ? tpl.zones : [],
        values: content.template_values || {},
      }
    }
    // tpl missing (template deleted) → resolvedUrl stays null and
    // the client falls back to the idle screen.
  }

  // A template push whose template has since been deleted has no
  // base image — treat it as idle rather than a broken render.
  const renderable = content && (content.source_type !== 'template' || template)

  return NextResponse.json({
    display: {
      id: display.id,
      label: display.label,
      location_id: display.location_id,
      // TV-ROTATION.1 — degrees the client counter-rotates the
      // stage by so content fills a non-landscape-mounted panel.
      rotation: display.rotation || 0,
    },
    content: renderable
      ? {
          source_type: content.source_type,
          resolved_url: resolvedUrl,
          label: content.label,
          pushed_at: content.pushed_at,
          triggered_by: content.triggered_by,
          // Present only for source_type 'template'.
          template,
        }
      : null,
  })
}
