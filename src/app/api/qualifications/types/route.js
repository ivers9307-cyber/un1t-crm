// QUALS.1 — POST: add a qualification type to the organisation of
// location_id. Owners (and masters) at a studio of that organisation, the
// same rule as PATCH and the page's can_edit_types (REVIEWNITS.1).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { QualificationTypeCreateSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, canEditCatalogue, createQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

// The studio comes from the body, so the role is judged there (and at the
// organisation's other studios), never at the active one.
export const POST = withAuth(
  { permission: null, location: false, schema: QualificationTypeCreateSchema },
  async ({ user, db, input }) => {
    const guard = assertLocationAccess(user, input.location_id)
    if (guard) return guard
    const loc = input.location_id
    const orgId = (user.locations || []).find((l) => l?.id === loc)?.organization_id
    if (!hasRoleAtLocation(user, loc, QUAL_CATALOGUE_ROLES) && !canEditCatalogue(user, orgId)) {
      return NextResponse.json({ success: false, error: 'Only an owner can change the list of qualifications.' }, { status: 403 })
    }
    const out = await createQualificationType(db, { user, input })
    return NextResponse.json(out.body, { status: out.status })
  },
)
