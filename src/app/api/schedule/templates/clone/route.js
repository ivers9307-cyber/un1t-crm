import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { organizationCheck } from '@/lib/shift-template-clone'

// TPLCLONE.1 — POST /api/schedule/templates/clone
//
// Copy shift templates from one studio into another studio of the SAME
// organisation. The caller needs a manager role (MANAGER_ROLES, the set that
// may create a template) AT BOTH studios; a master passes that, and is still
// held to one organisation.
//
// Why the organisation is read and not inferred: membership proves nothing
// about it. A master's user.locations is every active studio on the estate, an
// org admin's is every studio of every org they administer, and nothing keeps a
// person inside one organisation (ORGSCOPE.1). So both studios' rows are read
// and their organization_id compared, both present AND equal.
//
// 403 on every refusal of a body-param studio (assertLocationAccess's
// convention). The cross-organisation 403 discloses nothing: only a caller who
// is already a member of both studios can reach it.
const CloneTemplatesSchema = z.object({
  from_location_id: uuidLike,
  to_location_id: uuidLike,
  template_ids: z.array(uuidLike).min(1).max(200).optional(),
  dry_run: z.boolean().optional(),
}).refine((b) => b.from_location_id !== b.to_location_id, {
  message: 'Choose a different studio to copy from',
  path: ['from_location_id'],
})

const refuse = (status, error) => NextResponse.json({ success: false, error }, { status })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return refuse(403, 'Unauthorized')

  const validation = await validateBody(request, CloneTemplatesSchema)
  if (!validation.ok) return validation.response
  const { from_location_id: fromId, to_location_id: toId } = validation.data

  // Membership first, so a studio the caller is not at is answered as that,
  // not with a role complaint that confirms it exists.
  for (const id of [fromId, toId]) {
    const guard = assertLocationAccess(user, id)
    if (guard) return guard
  }
  if (!hasRoleAtLocation(user, fromId, MANAGER_ROLES) || !hasRoleAtLocation(user, toId, MANAGER_ROLES)) {
    return refuse(403, 'You need to be a manager at both studios to copy templates between them.')
  }

  const db = createServerClient()

  const { data: studios, error: studiosErr } = await db
    .from('locations')
    .select('id, organization_id')
    .in('id', [fromId, toId])
  if (studiosErr) return refuse(500, 'Could not check the two studios; nothing was copied.')
  const org = organizationCheck(studios, fromId, toId)
  if (org === 'not_found') return refuse(404, 'Studio not found')
  if (org !== 'same_org') return refuse(403, 'Templates can only be copied between studios in the same organisation.')

  // The copy itself lands in the next commit. Until then the gates answer an empty dry run.
  return NextResponse.json({ success: true, data: { dry_run: true, created: [], skipped: [], generated_blocks: 0 } })
}
