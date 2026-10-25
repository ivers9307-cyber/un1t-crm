// QUALS.1 — POST: add a qualification type to the organisation of
// location_id. Owners (and masters) at a studio of that organisation, the
// same rule as PATCH and the page's can_edit_types (REVIEWNITS.1).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { QualificationTypeCreateSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, canEditCatalogue, createQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const validation = await validateBody(request, QualificationTypeCreateSchema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard
  const loc = validation.data.location_id
  const orgId = (user.locations || []).find((l) => l?.id === loc)?.organization_id
  if (!hasRoleAtLocation(user, loc, QUAL_CATALOGUE_ROLES) && !canEditCatalogue(user, orgId)) {
    return NextResponse.json({ success: false, error: 'Only an owner can change the list of qualifications.' }, { status: 403 })
  }
  const out = await createQualificationType(createServerClient(), { user, input: validation.data })
  return NextResponse.json(out.body, { status: out.status })
}
