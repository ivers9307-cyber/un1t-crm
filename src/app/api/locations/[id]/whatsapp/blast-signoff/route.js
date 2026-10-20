// ORGCONTACTS.0 (spec §3.3, decision 6; WAORGNUMBER R7) — the studio's blast
// sign-off window, which until now was a hand-set setting.
//
// While locations.settings.whatsapp_blast_signoff_until is in the future, a
// broadcast at the studio goes out only once an organisation admin has signed
// it off (src/lib/whatsapp-blast-signoff.js). The window exists to bind
// managers, so only a master or an org admin of the studio's organisation may
// set or clear it; anyone with access to the studio may read it.
//
// GET /api/locations/[id]/whatsapp/blast-signoff   { until: 'YYYY-MM-DD'|null, can_edit }
// PUT /api/locations/[id]/whatsapp/blast-signoff   { until: 'YYYY-MM-DD'|null }
//   The date is a calendar day on the studio's clock (the gate holds through
//   that day; the copy names it). A day that does not exist (30 Feb) is 400.
//   null removes the key. Sibling settings keys are kept (mergeLocationSettings).
//   Only `until` and `can_edit` ever leave the route: settings hold credentials.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { studioBlastSignoffSchema } from '@/lib/schemas'
import { isOrgAdmin } from '@/lib/org-admin'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { SIGNOFF_SETTING_KEY } from '@/lib/whatsapp-blast-signoff'
import { strictDayStartMsIn } from 'shared/zoned-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error, status = 500) => NextResponse.json({ success: false, error }, { status })
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function untilOf(settings) {
  const raw = settings?.[SIGNOFF_SETTING_KEY]
  return typeof raw === 'string' && DATE_ONLY.test(raw.trim()) ? raw.trim() : null
}

async function readStudio(db, locationId) {
  const { data, error } = await db.from('locations').select('id, organization_id, settings').eq('id', locationId).maybeSingle()
  if (error) return { response: fail(error.message) }
  if (!data) return { response: fail('Studio not found', 404) }
  return { location: data }
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorised', 401)
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const studio = await readStudio(createServerClient(), params.id)
  if (studio.response) return studio.response
  const { location } = studio
  return NextResponse.json({
    success: true,
    data: { until: untilOf(location.settings), can_edit: isOrgAdmin(user, location.organization_id) },
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorised', 401)
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const result = await validateBody(request, studioBlastSignoffSchema)
  if (!result.ok) return result.response
  const { until } = result.data

  const db = createServerClient()
  const studio = await readStudio(db, locationId)
  if (studio.response) return studio.response
  const { location } = studio
  if (!isOrgAdmin(user, location.organization_id)) {
    return fail('Only an organisation admin can set the blast sign-off window at this studio.', 403)
  }
  // Judged on UTC's calendar: the question is whether the day exists, which
  // no zone changes; the window itself is read on the studio's clock.
  if (until !== null && strictDayStartMsIn(until, 'UTC') == null) {
    return fail('Use a real calendar date like 2026-11-16.', 400)
  }

  const saved = await mergeLocationSettings(db, locationId, (current) => {
    const next = { ...current }
    if (until === null) delete next[SIGNOFF_SETTING_KEY]
    else next[SIGNOFF_SETTING_KEY] = until
    return next
  }, { scope: 'wa-blast-signoff' })
  if (!saved.ok) return settingsSaveFailure(saved)

  return NextResponse.json({ success: true, data: { until: untilOf(saved.settings), can_edit: true } })
}
