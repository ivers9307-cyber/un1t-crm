// FEES.4 — the studio's members who are never charged a class fee.
//   GET    ?location_id=                          the list, with names
//   POST   { location_id, contact_id, note? }     add (also waives their open fees)
//   DELETE { location_id, contact_id }            remove (past fees untouched)
// Session auth + the class_fees permission at that studio. A contact outside
// the studio's organisation answers 404.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { listExemptions, addExemption, removeExemption } from '@/lib/class-fees-exemptions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const AddExemptionSchema = z.object({
  location_id: uuidLike,
  contact_id: uuidLike,
  note: z.string().trim().max(500).optional(),
})
export const RemoveExemptionSchema = z.object({ location_id: uuidLike, contact_id: uuidLike })

// withAuth only signs the caller in (so a signed-out call is its 401 before
// the input is read). For a signed-in caller the order is as before: the
// input (400), the studio check, then class_fees there (403).
function gate(user, locationId) {
  const guard = assertLocationAccess(user, locationId)
  if (guard) return { res: guard }
  if (!canUseClassFees(user, locationId)) return { res: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  return { user }
}

export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!uuidLike.safeParse(locationId).success) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const g = gate(user, locationId)
  if (g.res) return g.res
  try {
    return NextResponse.json({ success: true, data: { rows: await listExemptions(db, locationId) } })
  } catch (err) {
    logError('class-fees', 'exemption list failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load the list just now.' }, { status: 500 })
  }
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const validation = await validateBody(request, AddExemptionSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, contact_id: contactId, note } = validation.data
  const g = gate(user, locationId)
  if (g.res) return g.res
  try {
    const r = await addExemption(db, { locationId, contactId, note, actorId: g.user.id })
    if (!r.ok) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, data: { exempt: true, waived: r.waived } })
  } catch (err) {
    logError('class-fees', 'exemption add failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not add the member just now.' }, { status: 500 })
  }
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const validation = await validateBody(request, RemoveExemptionSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, contact_id: contactId } = validation.data
  const g = gate(user, locationId)
  if (g.res) return g.res
  try {
    const r = await removeExemption(db, { locationId, contactId })
    return NextResponse.json({ success: true, data: { exempt: false, removed: r.removed } })
  } catch (err) {
    logError('class-fees', 'exemption remove failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not remove the member just now.' }, { status: 500 })
  }
})
