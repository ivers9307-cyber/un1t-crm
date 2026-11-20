// MEMBERWRITESWEEP.1f — one TV template (session auth; web + phone editors).
//
//   GET    → the template (with its studio, which the phone's editor uploads
//            a new base image at: C118)
//   PUT    { name, base_image_path, zones } → save; stamps updated_at
//   DELETE → remove it (a TV showing it falls back to idle)
//
// Replaces the direct tv_templates read/update/delete from a client session
// under nothing but the membership policy. Gate: tv_displays, web OR mobile,
// at the TEMPLATE's own studio (loadTvTemplateForUser), never the caller's
// active one; writes are narrowed to that studio. A NEW base image must sit
// in that studio's templates folder: C118, the phone uploaded it at the
// ACTIVE studio while editing another studio's template. An unchanged base
// image is kept as it is.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import {
  loadTvTemplateForUser, isTemplateBaseImagePath, TvTemplateSaveSchema,
  TV_TEMPLATE_COLUMNS, UNIQUE_VIOLATION, BASE_IMAGE_ELSEWHERE, tvBadRequest, tvConflict, tvNotFound, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; loadTvTemplateForUser keeps every other
// check (tv_displays anywhere, the id, the template's studio, the key there).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const id = params?.id
  const { template, response } = await loadTvTemplateForUser(db, user, id, TV_TEMPLATE_COLUMNS)
  if (response) return response
  return NextResponse.json({ success: true, data: template })
})

export const PUT = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  const { template, response } = await loadTvTemplateForUser(db, user, id, 'id, location_id, base_image_path')
  if (response) return response

  const validation = await validateBody(request, TvTemplateSaveSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (body.base_image_path !== template.base_image_path && !isTemplateBaseImagePath(body.base_image_path, template.location_id)) {
    return tvBadRequest(BASE_IMAGE_ELSEWHERE)
  }

  const { data, error } = await db.from('tv_templates')
    .update({
      name: body.name,
      base_image_path: body.base_image_path,
      zones: body.zones,
      updated_at: new Date().toISOString(),
    })
    .eq('id', template.id)
    .eq('location_id', template.location_id)
    .select(TV_TEMPLATE_COLUMNS)
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return tvConflict(`A template called "${body.name}" already exists here.`)
    logError('tv-templates', 'template save failed', { id: template.id, err: error })
    return tvServerError('Could not save the template.')
  }
  if (!data || data.length === 0) return tvNotFound('Template')

  return NextResponse.json({ success: true, data: data[0] })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const id = params?.id
  const { template, response } = await loadTvTemplateForUser(db, user, id, 'id, location_id')
  if (response) return response

  // Zero rows = deleted since the read: gone is what was asked, 200.
  const { error } = await db.from('tv_templates')
    .delete()
    .eq('id', template.id)
    .eq('location_id', template.location_id)
    .select('id')
  if (error) {
    logError('tv-templates', 'template delete failed', { id: template.id, err: error })
    return tvServerError('Could not delete the template.')
  }

  return NextResponse.json({ success: true })
})
