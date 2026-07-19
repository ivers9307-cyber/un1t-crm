// /api/chooser-settings/tile-image — upload a chooser tile cover image
// for one studio. Mirrors the landing-page hero-image route: multipart
// form, stores in the 'branding' bucket, writes chooser_image_url on the
// studio's landing_page_settings row, returns the public URL.
//
// Auth (SAAS-6): the front-page edit tier — master, org_admin of the
// tile's org, or an owner WITHIN that org (assertChooserEdit, shared
// with /api/chooser-settings). The pre-SAAS-6 master-or-ANY-owner gate
// let one tenant's owner overwrite another tenant's tile cover; the
// tile's location resolves to its organization and the gate binds there.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { assertChooserEdit } from '@/lib/chooser-access'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_BYTES = 8 * 1024 * 1024 // 8MB — full-screen covers run large
const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData()
  const file = form.get('file')
  const locationId = form.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ success: false, error: 'Unsupported file type. Use PNG, JPEG, or WebP.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ success: false, error: `File is too large (${Math.round(file.size / 1024)}KB). Max is 8MB.` }, { status: 400 })
  }

  const db = createServerClient()

  // Resolve the tile's org and bind the edit gate to it. A location the
  // caller's orgs can't reach answers 404 — indistinguishable from a
  // location that doesn't exist.
  const { data: loc } = await db
    .from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  if (!loc?.organization_id) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertChooserEdit(user, loc.organization_id)
  if (guard) return guard

  const ext = EXT_BY_TYPE[file.type]
  const path = `landing-page/${locationId}/chooser.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Clear stale chooser images at other extensions so PNG -> JPG
  // re-upload doesn't leave both behind.
  try {
    const { data: existing } = await db.storage.from('branding').list(`landing-page/${locationId}`)
    const stale = (existing || [])
      .filter((o) => /^chooser\.(png|jpg|webp)$/.test(o.name) && o.name !== `chooser.${ext}`)
      .map((o) => `landing-page/${locationId}/${o.name}`)
    if (stale.length) await db.storage.from('branding').remove(stale)
  } catch { /* best-effort cleanup */ }

  const { error: upErr } = await db.storage.from('branding').upload(path, buffer, { contentType: file.type, upsert: true })
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })

  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  // Cache-bust so the new cover shows immediately.
  const publicUrl = `${urlData.publicUrl}?v=${Date.now()}`

  const { error: rowErr } = await db.from('landing_page_settings')
    .update({ chooser_image_url: publicUrl })
    .eq('location_id', locationId)
  if (rowErr) return NextResponse.json({ success: false, error: rowErr.message }, { status: 400 })

  return NextResponse.json({ success: true, data: { url: publicUrl } })
}
