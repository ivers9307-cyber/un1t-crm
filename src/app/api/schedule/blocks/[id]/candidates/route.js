// CANDIDATES.1 — GET /api/schedule/blocks/[id]/candidates
//
// The coaches who could take this shift, RANKED, each with the reason. Used
// by the web assign picker, the phone's Manage "Add coach" sheet and the
// phone's "Ask a coach to cover" sheet. ADVISORY ONLY: POST
// /api/schedule/blocks/[id]/assignments and POST /api/schedule/swaps never
// consult it, and every picker keeps every row pickable.
//
// Two audiences (decided here, never by the client):
//   manager    MANAGER_ROLES AT the block's studio (master bypasses): every
//              fact — free/busy at any studio of the organisation, leave,
//              availability with its note, on site, week minutes, rest and
//              48h advisories; employees' contracted hours ONLY for an
//              owner, a manager or a master (never a head coach).
//   colleague  a coach LIVE on the block (the one asking for cover): free or
//              working only, ranked on that alone. A coach never sees a
//              colleague's leave, availability, hours or contract.
// Anyone else at the studio: 403. Outside the studio: 404, so the block id is
// never confirmed (SCHEDROLES.1's rule, as the assign route).
//
// Hours only: no rate, salary, overtime or cost is read or returned
// (src/lib/candidates-data.js names every column).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { liveAssignments } from '@/lib/roster'
import { loadBlockCandidates } from '@/lib/candidates-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const parsed = uuidLike.safeParse(params?.id)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid block id' }, { status: 400 })

  const db = createServerClient()

  // Block lookup: also the studio-ownership gate.
  const { data: block, error: blockErr } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, roster_id, rosters:roster_id(status), shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    .eq('id', parsed.data)
    .maybeSingle()
  if (blockErr) return NextResponse.json({ success: false, error: blockErr.message }, { status: 500 })
  if (!block) return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })

  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere

  const isManager = hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)
  const onBlock = liveAssignments(block.shift_assignments).some((a) => a.profile_id === user.id)
  if (!isManager && !onBlock) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const audience = isManager ? 'manager' : 'colleague'
  // A coach never sees a draft (ROSTER-FIX.1 D1): the swap POST refuses a
  // shift on an unpublished roster with the same words, so no cover can be
  // asked for one anyway. A manager plans drafts, so is not refused.
  if (audience === 'colleague' && block.rosters?.status !== 'published') {
    return NextResponse.json({ success: false, error: 'That shift is not published yet' }, { status: 400 })
  }

  // CANDIDATES.1 review 4 (owner decision pending; the conservative side):
  // contracted hours reach an owner, a manager or a master AT this studio,
  // never a head coach, though a head coach gets the ranked list.
  const withContract = audience === 'manager' && hasRoleAtLocation(user, block.location_id, ADMIN_ROLES)

  const out = await loadBlockCandidates(db, { block, audience, withContract })
  if (out.error) {
    return NextResponse.json({ success: false, error: out.error.message || 'Candidates could not be read' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { audience, block_id: block.id, candidates: out.candidates, checked: out.checked, untimed: out.untimed },
  })
}
