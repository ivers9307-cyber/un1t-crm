// QUALS.1 — PATCH one qualification type: rename it, archive it
// (active: false) or restore it. Owners (and masters) of its organisation,
// judged on the row; anyone else, a missing id and a malformed id are 404.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationTypePatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, updateQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, QUAL_CATALOGUE_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only an owner can change the list of qualifications.' }, { status: 403 })
  }
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const validation = await validateBody(request, QualificationTypePatchSchema)
  if (!validation.ok) return validation.response
  const out = await updateQualificationType(createServerClient(), { user, id: params.id, input: validation.data })
  return NextResponse.json(out.body, { status: out.status })
}
