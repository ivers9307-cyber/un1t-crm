// MEMBERWRITESWEEP.1f — a studio's TV templates (session auth; web + phone).
//
//   GET  ?location_id=  → the studio's templates by name
//   POST { location_id, name, base_image_path, zones } → create one;
//        created_by is the caller, never the body
//
// Replaces the direct tv_templates read/insert from a client session under
// nothing but the membership policy. The base image must sit in the studio's
// templates folder (<studio>/templates/), where the upload routes put it.
// Gate: tv_displays, web OR mobile, at the studio (src/lib/tv-admin.js).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  tvAdminAnywhereGate, authoriseTvLocation, isTemplateBaseImagePath, TvTemplateCreateSchema,
  TV_TEMPLATE_COLUMNS, UNIQUE_VIOLATION, BASE_IMAGE_ELSEWHERE, tvBadRequest, tvConflict, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  const coarse = tvAdminAnywhereGate(user)
  if (coarse) return coarse

  const locationId = new URL(request.url).searchParams.get('location_id') || user.activeLocation?.id
  const gate = authoriseTvLocation(user, locationId)
  if (gate) return gate

  const db = createServerClient()
  const { data, error } = await db.from('tv_templates')
    .select(TV_TEMPLATE_COLUMNS)
    .eq('location_id', locationId)
    .order('name', { ascending: true })
  if (error) return tvServerError('Could not load the templates')

  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  const coarse = tvAdminAnywhereGate(user)
  if (coarse) return coarse

  const validation = await validateBody(request, TvTemplateCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const gate = authoriseTvLocation(user, body.location_id)
  if (gate) return gate
  if (!isTemplateBaseImagePath(body.base_image_path, body.location_id)) return tvBadRequest(BASE_IMAGE_ELSEWHERE)

  const db = createServerClient()
  const { data, error } = await db.from('tv_templates')
    .insert({
      location_id: body.location_id,
      name: body.name,
      base_image_path: body.base_image_path,
      zones: body.zones,
      created_by: user.id,
    })
    .select(TV_TEMPLATE_COLUMNS)
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return tvConflict(`A template called "${body.name}" already exists here.`)
    return tvServerError(`Could not save the template: ${error.message}`)
  }
  if (!data) return tvServerError('Could not save the template')

  return NextResponse.json({ success: true, data })
}
