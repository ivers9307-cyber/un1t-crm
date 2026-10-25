// QUALS.1 — PATCH (dates, note) and DELETE one qualification record. Owners
// and managers at a studio the person belongs to, judged on the row in
// src/lib/qualifications-server.js. Detail route: a record the caller may not
// touch, a missing one and a malformed id are all 404.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationRecordPatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_MANAGER_ROLES, updateQualificationRecord, deleteQualificationRecord } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const send = (out) => NextResponse.json(out.body, { status: out.status })

async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasRoleAtAnyLocation(user, QUAL_MANAGER_ROLES)) {
    return { response: NextResponse.json({ success: false, error: 'Only an owner or a manager can change qualifications.' }, { status: 403 }) }
  }
  if (!uuidLike.safeParse(params?.id).success) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }
  return { user, id: params.id }
}

export async function PATCH(request, props) {
  const { user, id, response } = await gate(props)
  if (response) return response
  const validation = await validateBody(request, QualificationRecordPatchSchema)
  if (!validation.ok) return validation.response
  return send(await updateQualificationRecord(createServerClient(), { user, id, input: validation.data }))
}

export async function DELETE(request, props) {
  const { user, id, response } = await gate(props)
  if (response) return response
  return send(await deleteQualificationRecord(createServerClient(), { user, id }))
}
