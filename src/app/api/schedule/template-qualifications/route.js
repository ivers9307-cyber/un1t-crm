// QUALS.1 — what shift templates ask for (ADVISORY: the ranked picker badges
// a coach without a current record; nothing refuses an assignment).
// GET ?location_id= : the studio's organisation catalogue and every template's
//   requirements, for the template editor.
// PUT { template_id, qualification_type_ids (<= 5) }: replace one template's.
// Same gate as the template editor (SCHEDROLES.1): MANAGER_ROLES at the studio
// (the template's studio for PUT, judged on the row: 404 outside it, 403 for
// a member who is not a manager there).

import { NextResponse } from 'next/server'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { TemplateQualificationsPutSchema } from '@/lib/qualifications-schemas'
import { readTemplateRequirements, replaceTemplateRequirements } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const FORBIDDEN = 'Only a manager at this studio can change what a shift template asks for.'

// GET: withAuth only signs the caller in; the query's studio is judged below
// (400 malformed, 403 not a member, 403 not a manager there), as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: FORBIDDEN }, { status: 403 })
  }
  const out = await readTemplateRequirements(db, { locationId })
  return NextResponse.json(out.body, { status: out.status })
})

// PUT: a manager somewhere (the same 403), then the body; the template's own
// studio is judged on the row in qualifications-server, as before.
export const PUT = withAuth(
  { permission: null, location: false, allow: (user) => hasRoleAtAnyLocation(user, MANAGER_ROLES), forbiddenMessage: FORBIDDEN },
  async ({ user, db, request }) => {
    const validation = await validateBody(request, TemplateQualificationsPutSchema)
    if (!validation.ok) return validation.response
    const out = await replaceTemplateRequirements(db, { user, input: validation.data })
    return NextResponse.json(out.body, { status: out.status })
  },
)
