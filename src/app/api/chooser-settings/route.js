// /api/chooser-settings — GET + PUT for the public front-page split
// chooser at un1tdublin.com (the /welcome chooser).
//
// Singleton row (id='default'): page-level headline/intro + tile order.
// Per-tile label / CTA / cover live on landing_page_settings and are
// edited together here in one PUT so the operator saves the whole front
// page at once.
//
// Auth: master OR owner (the chooser is a single global page, not per
// location). The table RLS write policy mirrors this as defence in
// depth; this route is the primary gate.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { PUBLISH_STATES } from '@/lib/landing-page-visibility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canEdit(user) {
  return !!user && (user.profileRole === 'master' || user.role === 'master' || user.role === 'owner')
}

export const TileSchema = z.object({
  location_id:      uuidLike,
  public_path:      z.string().trim().min(1).max(120),
  chooser_label:    z.string().trim().max(200).nullable().optional(),
  chooser_cta_text: z.string().trim().max(60).nullable().optional(),
  publish_state:    z.enum(PUBLISH_STATES).optional(),
}).strict()

const PutSchema = z.object({
  headline:   z.string().trim().max(200).nullable().optional(),
  intro:      z.string().trim().max(600).nullable().optional(),
  // Ordered list of public_path values (left -> right / top -> bottom).
  tile_order: z.array(z.string().trim().min(1).max(120)).max(20),
  // Per-tile label/CTA overrides keyed by location_id.
  tiles:      z.array(TileSchema).max(20),
}).strict()

export async function GET() {
  const user = await getCurrentUser()
  if (!canEdit(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner required' }, { status: 403 })
  }
  const db = createServerClient()
  const [chooserRes, tilesRes] = await Promise.all([
    db.from('chooser_settings').select('*').eq('id', 'default').maybeSingle(),
    db.from('landing_page_settings')
      .select('location_id, public_path, chooser_label, chooser_cta_text, chooser_image_url, publish_state, locations:location_id ( name )')
      .not('public_path', 'is', null),
  ])
  return NextResponse.json({
    success: true,
    data: {
      chooser: chooserRes.data || { id: 'default', headline: null, intro: null, tile_order: [] },
      tiles: (tilesRes.data || []).map((t) => ({
        location_id: t.location_id,
        public_path: t.public_path,
        name: t.locations?.name || t.public_path,
        chooser_label: t.chooser_label,
        chooser_cta_text: t.chooser_cta_text,
        chooser_image_url: t.chooser_image_url,
        publish_state: t.publish_state,
      })),
    },
  })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!canEdit(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner required' }, { status: 403 })
  }
  let body
  try { body = PutSchema.parse(await request.json()) }
  catch (e) { return NextResponse.json({ success: false, error: e.errors?.[0]?.message || 'Invalid body' }, { status: 400 }) }

  const db = createServerClient()

  // 1. Upsert the singleton chooser row.
  const { error: chErr } = await db.from('chooser_settings').upsert({
    id: 'default',
    headline: body.headline ?? null,
    intro: body.intro ?? null,
    tile_order: body.tile_order,
    updated_at: new Date().toISOString(),
    updated_by: user.id || null,
  }, { onConflict: 'id' })
  if (chErr) return NextResponse.json({ success: false, error: chErr.message }, { status: 400 })

  // 2. Per-tile label/CTA overrides. Only touch rows the caller sent;
  //    each is scoped by location_id so we never clobber a sibling.
  for (const t of body.tiles) {
    const tilePatch = { chooser_label: t.chooser_label ?? null, chooser_cta_text: t.chooser_cta_text ?? null }
    if (t.publish_state) tilePatch.publish_state = t.publish_state
    const { error } = await db.from('landing_page_settings')
      .update(tilePatch)
      .eq('location_id', t.location_id)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
