// MEMBERWRITESWEEP.1f — what one TV shows (session auth; web TV admin + phone).
//
//   PUT    { source_type, source_ref, label?, template_values? } → push: upsert
//          the TV's single tv_content row (onConflict tv_display_id)
//   DELETE → clear the TV back to its idle screen
//
// Replaces the direct tv_content upsert/delete from a client session, where
// pushed_by/triggered_by were whatever the client sent and any source_ref was
// stored for the public cast page to render. The server now stamps pushed_at,
// pushed_by and triggered_by from the session, and validates the push
// (DECISION 4, validateTvPush): http(s) URLs only, photos from this studio's
// folder, templates of this studio. Gate: tv_displays, web OR mobile, at the
// TV's own studio. The Hyrox push (/api/hyrox/sessions/[id]/push and the
// publish runner) writes tv_content with the service role and is unchanged.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { ringScreensForDisplay } from '@/lib/screen-doorbell'
import {
  loadTvDisplayForUser, validateTvPush, TvPushSchema, TV_CONTENT_COLUMNS, tvBadRequest, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

class TemplateReadError extends Error {}

// withAuth only signs the caller in; loadTvDisplayForUser keeps the coarse
// tv_displays check and the TV's studio (404), as before.
export const PUT = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const { display, response } = await loadTvDisplayForUser(db, user, params?.id, 'id, location_id')
  if (response) return response

  const validation = await validateBody(request, TvPushSchema)
  if (!validation.ok) return validation.response

  let checked
  try {
    checked = await validateTvPush(validation.data, {
      locationId: display.location_id,
      templateLocationOf: async (templateId) => {
        // Scoped to the TV's studio: another studio's template reads as none.
        const { data, error } = await db.from('tv_templates').select('location_id')
          .eq('id', templateId).eq('location_id', display.location_id).maybeSingle()
        if (error) throw new TemplateReadError(error.message)
        return data?.location_id ?? null
      },
    })
  } catch (e) {
    if (e instanceof TemplateReadError) return tvServerError('Could not read the template')
    throw e
  }
  if (!checked.ok) return tvBadRequest(checked.error)

  const { data, error } = await db.from('tv_content')
    .upsert({
      tv_display_id: display.id,
      ...checked.value,
      pushed_at: new Date().toISOString(),
      pushed_by: user.id,
      triggered_by: `manual:${user.id}`,
    }, { onConflict: 'tv_display_id' })
    .select(TV_CONTENT_COLUMNS)
    .single()
  if (error) {
    logError('tv-admin', 'push not saved', { tvId: display.id, code: error.code ?? null })
    return tvServerError('Could not push to the TV.')
  }

  // SCREENMODE.9 — wake the screen boxes linked to this TV so they reload now
  // instead of at their next (slow, kiosk) poll.
  try { await ringScreensForDisplay(db, display.id) } catch { /* a ring never changes the response */ }

  return NextResponse.json({ success: true, data })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { display, response } = await loadTvDisplayForUser(db, user, params?.id, 'id, location_id')
  if (response) return response

  // Already idle (zero rows) is the state that was asked for: 200.
  const { error } = await db.from('tv_content')
    .delete()
    .eq('tv_display_id', display.id)
    .select('tv_display_id')
  if (error) {
    logError('tv-admin', 'clear not saved', { tvId: display.id, code: error.code ?? null })
    return tvServerError('Could not clear the TV.')
  }

  try { await ringScreensForDisplay(db, display.id) } catch { /* a ring never changes the response */ }

  return NextResponse.json({ success: true })
})
