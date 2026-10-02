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
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  loadTvDisplayForUser, validateTvPush, TvPushSchema, TV_CONTENT_COLUMNS, tvBadRequest, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

class TemplateReadError extends Error {}

export async function PUT(request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { display, response } = await loadTvDisplayForUser(db, user, id, 'id, location_id')
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
  if (error) return tvServerError(`Could not push to the TV: ${error.message}`)

  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { display, response } = await loadTvDisplayForUser(db, user, id, 'id, location_id')
  if (response) return response

  // Already idle (zero rows) is the state that was asked for: 200.
  const { error } = await db.from('tv_content')
    .delete()
    .eq('tv_display_id', display.id)
    .select('tv_display_id')
  if (error) return tvServerError(`Could not clear the TV: ${error.message}`)

  return NextResponse.json({ success: true })
}
