// QUALS.1 — PATCH (dates, note) and DELETE one qualification record. Owners
// and managers at a studio the person belongs to, judged on the row in
// src/lib/qualifications-server.js. Detail route: a record the caller may not
// touch, a missing one and a malformed id are all 404.

import { NextResponse } from 'next/server'
import { hasRoleAtAnyLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationRecordPatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_MANAGER_ROLES, updateQualificationRecord, deleteQualificationRecord } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const send = (out) => NextResponse.json(out.body, { status: out.status })

// withAuth signs the caller in; the coarse role check (an owner or manager
// somewhere) answers the same 403, then a malformed id is a 404 before the
// body is read. The row's own studio is judged in qualifications-server.
const GATE = {
  permission: null,
  location: false,
  allow: (user) => hasRoleAtAnyLocation(user, QUAL_MANAGER_ROLES),
  forbiddenMessage: 'Only an owner or a manager can change qualifications.',
}
const badId = (params) => !uuidLike.safeParse(params?.id).success
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export const PATCH = withAuth(GATE, async ({ user, db, request, params }) => {
  if (badId(params)) return notFound()
  const validation = await validateBody(request, QualificationRecordPatchSchema)
  if (!validation.ok) return validation.response
  return send(await updateQualificationRecord(db, { user, id: params.id, input: validation.data }))
})

export const DELETE = withAuth(GATE, async ({ user, db, params }) => {
  if (badId(params)) return notFound()
  return send(await deleteQualificationRecord(db, { user, id: params.id }))
})
