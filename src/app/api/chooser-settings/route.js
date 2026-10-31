// /api/chooser-settings — GET + PUT for the public front-page split
// chooser at un1tdublin.com (the /welcome chooser).
//
// SAAS-6: per-ORGANIZATION rows (mig 414; was a singleton from mig
// 228). Each tenant brand gets its own front page — one
// chooser_settings row per org holding the page-level headline/intro +
// tile order; per-tile label / CTA / cover live on the studio page's
// chrome (PAGES.1: the ORG's kind='studio' landing_pages rows, one per
// studio; chrome.chooser_label / chooser_cta_text / chooser_image_url)
// and are edited together here in one PUT so the operator saves the
// whole front page at once. A tile's publish_state is its studio page's:
// hidden is a draft page (a retired page also reads as hidden, and a save
// that leaves a hidden tile hidden keeps it retired).
//
// Org resolution: explicit ?organization_id wins, else the caller's
// activeOrganization (src/lib/chooser-access.js). Reads need org
// membership; writes need master, an org_admin grant, or an owner
// WITHIN the org — the pre-SAAS-6 gate was master-or-ANY-owner, which
// let one tenant's owner edit another tenant's front page, and that
// hole is closed here. A foreign org answers 404 (indistinguishable
// from missing). Table RLS (mig 414) mirrors this as defence in depth;
// this route is the primary gate.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { chooserRowId, resolveChooserOrgId, assertChooserRead, assertChooserEdit } from '@/lib/chooser-access'
import { uuidLike } from '@/lib/schemas'
import { PUBLISH_STATES, tileStateToPageState, pageStateToTileState } from '@/lib/landing-page-visibility'
import { loadStudioPagesByLocation, savePageFields, PageReadError } from '@/lib/landing-pages'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function GET(request) {
  const user = await getCurrentUser()
  const orgId = user ? resolveChooserOrgId(user, request) : null
  const guard = assertChooserRead(user, orgId)
  if (guard) return guard

  const db = createServerClient()
  const [chooserRes, tilesRes] = await Promise.all([
    db.from('chooser_settings').select('*').eq('organization_id', orgId).maybeSingle(),
    // PAGES.1 — the org's studio pages (scoped by the org id: another
    // tenant's studios never surface, or become editable, in this chooser).
    db.from('landing_pages')
      .select('primary_location_id, slug, chrome, publish_state, locations:primary_location_id ( name )')
      .eq('kind', 'studio')
      .eq('organization_id', orgId),
  ])
  return NextResponse.json({
    success: true,
    data: {
      // No row yet = this org hasn't edited its front page; PUT creates
      // it (upsert-on-first-edit below).
      chooser: chooserRes.data
        || { id: chooserRowId(orgId), organization_id: orgId, headline: null, intro: null, tile_order: [] },
      tiles: (tilesRes.data || []).map((t) => ({
        location_id: t.primary_location_id,
        public_path: t.slug,
        name: t.locations?.name || t.slug,
        chooser_label: t.chrome?.chooser_label ?? null,
        chooser_cta_text: t.chrome?.chooser_cta_text ?? null,
        chooser_image_url: t.chrome?.chooser_image_url ?? null,
        // The page's four states as the editor's three (draft, retired: hidden).
        publish_state: pageStateToTileState(t.publish_state),
      })),
    },
  })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  const orgId = user ? resolveChooserOrgId(user, request) : null
  const guard = assertChooserEdit(user, orgId)
  if (guard) return guard

  const v = await validateBody(request, PutSchema)
  if (!v.ok) return v.response
  const body = v.data

  const db = createServerClient()

  // Tile writes must stay inside the org: resolve the org's location
  // set once and refuse any tile targeting a foreign location — 404,
  // indistinguishable from a location that doesn't exist.
  const { data: orgLocs, error: locErr } = await db
    .from('locations').select('id').eq('organization_id', orgId)
  if (locErr) return NextResponse.json({ success: false, error: locErr.message }, { status: 400 })
  const orgLocationIds = new Set((orgLocs || []).map((l) => l.id))
  for (const t of body.tiles) {
    if (!orgLocationIds.has(t.location_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
  }

  // Every tile's studio page is read BEFORE the first write: a tile with no
  // studio page in this org answers 404 and nothing is saved.
  let pages
  try {
    pages = await loadStudioPagesByLocation(db, { orgId, locationIds: body.tiles.map((t) => t.location_id) })
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    logError('chooser-settings', 'studio pages unreadable', { orgId, code: err.cause?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not read the studio pages. Try again.' }, { status: 500 })
  }
  for (const t of body.tiles) {
    if (!pages.has(t.location_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
  }

  // 1. Write THIS org's chooser row. Select-then-write rather than a
  //    single ON CONFLICT upsert: the legacy UN1T row keeps id
  //    'default' while new orgs derive theirs from the org id, so one
  //    upsert payload can't express both shapes.
  const patch = {
    headline: body.headline ?? null,
    intro: body.intro ?? null,
    tile_order: body.tile_order,
    updated_at: new Date().toISOString(),
    updated_by: user.id || null,
  }
  const { data: existing, error: exErr } = await db
    .from('chooser_settings').select('id').eq('organization_id', orgId).maybeSingle()
  if (exErr) return NextResponse.json({ success: false, error: exErr.message }, { status: 400 })
  if (existing) {
    const { error } = await db.from('chooser_settings').update(patch).eq('id', existing.id)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  } else {
    // First edit for this org — create its row (upsert-on-first-edit;
    // the UNIQUE index on organization_id backstops a racing double
    // create with an error rather than a second row).
    const { error } = await db.from('chooser_settings')
      .insert({ id: chooserRowId(orgId), organization_id: orgId, ...patch })
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // 2. Per-tile label / CTA (and visibility) on the studio page (read and
  //    org-checked above). The chooser keys MERGE into the page's chrome,
  //    which holds the logo, tone and terms copy as well. Each write is
  //    scoped by the page id inside this org, so a sibling is never clobbered.
  for (const t of body.tiles) {
    const page = pages.get(t.location_id)
    const patch = {
      chrome: {
        ...(page.chrome && typeof page.chrome === 'object' ? page.chrome : {}),
        chooser_label: t.chooser_label ?? null,
        chooser_cta_text: t.chooser_cta_text ?? null,
      },
      updated_by: user.id || null,
    }
    // Only a change of state is written, so a retired page that shows as
    // hidden keeps its redirect when the operator saves something else.
    if (t.publish_state && pageStateToTileState(page.publish_state) !== t.publish_state) {
      patch.publish_state = tileStateToPageState(t.publish_state)
      // A redirect belongs only to a retired page (table CHECK).
      patch.redirect_to = null
      if (patch.publish_state === 'live') patch.chrome.was_live = true
    }
    const saved = await savePageFields(db, { orgId, pageId: page.id, patch })
    if (!saved.ok) {
      const status = saved.reason === 'gone' ? 404 : 400
      return NextResponse.json({ success: false, error: saved.error?.message || 'Not found' }, { status })
    }
  }

  return NextResponse.json({ success: true })
}
