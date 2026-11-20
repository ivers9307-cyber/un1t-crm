// MEMBERWRITESWEEP.1f — one TV (session auth; web TV admin + phone).
//
//   PATCH  { rotation } → how the panel is hung (0, 90, 180, 270); the cast
//                         page picks it up on its next poll
//   DELETE              → remove the TV (its content row cascades); its cast
//                         URL stops working
//
// Replaces the direct tv_displays update/delete from a client session under
// nothing but the membership policy. Gate: tv_displays, web OR mobile, at the
// TV's own studio (loadTvDisplayForUser); a TV outside the caller's studios
// is a 404. Writes are narrowed to that studio too.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import {
  loadTvDisplayForUser, TvRotationSchema, tvNotFound, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; loadTvDisplayForUser keeps the coarse
// tv_displays check and the TV's studio (404), as before.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const { display, response } = await loadTvDisplayForUser(db, user, params?.id, 'id, location_id')
  if (response) return response

  const validation = await validateBody(request, TvRotationSchema)
  if (!validation.ok) return validation.response

  const { data, error } = await db.from('tv_displays')
    .update({ rotation: validation.data.rotation, updated_at: new Date().toISOString() })
    .eq('id', display.id)
    .eq('location_id', display.location_id)
    .select('id, rotation')
  if (error) {
    logError('tv-admin', 'rotation not saved', { tvId: display.id, code: error.code ?? null })
    return tvServerError('Could not change the orientation.')
  }
  if (!data || data.length === 0) return tvNotFound('TV')

  return NextResponse.json({ success: true, data: data[0] })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { display, response } = await loadTvDisplayForUser(db, user, params?.id, 'id, location_id')
  if (response) return response

  // Zero rows = deleted by someone else since the read: the TV is gone, which
  // is what was asked, so that is a 200 too.
  const { error } = await db.from('tv_displays')
    .delete()
    .eq('id', display.id)
    .eq('location_id', display.location_id)
    .select('id')
  if (error) {
    logError('tv-admin', 'tv not deleted', { tvId: display.id, code: error.code ?? null })
    return tvServerError('Could not delete the TV.')
  }

  return NextResponse.json({ success: true })
})
