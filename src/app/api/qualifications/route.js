// QUALS.1 — GET: the qualifications page's data for one studio. An owner or
// manager AT location_id (master bypasses) gets every current member of the
// studio with their records; anyone else at the studio gets their own,
// read-only. POST: record a qualification for someone. Only owners and
// managers get past the pre-check; whether THIS person is theirs is judged on
// the row (src/lib/qualifications-server.js), 404 if not.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { dublinTodayStr } from '@/lib/dublin-time'
import { QualificationRecordCreateSchema } from '@/lib/qualifications-schemas'
import { QUAL_MANAGER_ROLES, loadQualificationsPage, createQualificationRecord } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const send = (out) => NextResponse.json(out.body, { status: out.status })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  return send(await loadQualificationsPage(createServerClient(), { user, locationId, today: dublinTodayStr() }))
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Coarse pre-check only (SCHEDROLES.1): the authority decision is the role
  // at a studio the PERSON belongs to, judged on the row.
  if (!hasRoleAtAnyLocation(user, QUAL_MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only an owner or a manager can record qualifications.' }, { status: 403 })
  }
  const validation = await validateBody(request, QualificationRecordCreateSchema)
  if (!validation.ok) return validation.response

  return send(await createQualificationRecord(createServerClient(), { user, input: validation.data }))
}
