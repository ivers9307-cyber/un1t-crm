// QUALS.1 — PATCH one qualification type: rename it, archive it
// (active: false) or restore it. Owners (and masters) of its organisation,
// judged on the row; anyone else, a missing id and a malformed id are 404.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationTypePatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, updateQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

// The coarse "owner somewhere" check runs first (403); the row's organisation
// is judged in updateQualificationType. The body is validated after the id
// check so a malformed id stays a 404.
export const PATCH = withAuth(
  {
    permission: null,
    location: false,
    allow: (user) => hasRoleAtAnyLocation(user, QUAL_CATALOGUE_ROLES),
    forbiddenMessage: 'Only an owner can change the list of qualifications.',
  },
  async ({ user, db, request, params }) => {
    if (!uuidLike.safeParse(params?.id).success) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    const validation = await validateBody(request, QualificationTypePatchSchema)
    if (!validation.ok) return validation.response
    const out = await updateQualificationType(db, { user, id: params.id, input: validation.data })
    return NextResponse.json(out.body, { status: out.status })
  },
)
