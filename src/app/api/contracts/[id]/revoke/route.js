// /api/contracts/[id]/revoke
//
// Issuer (master/owner) revokes a contract that hasn't been signed
// yet. Useful when a typo / wrong template / wrong recipient is
// caught after issuing.
//
// Allowed only when:
//   - caller is master or owner
//   - status is 'issued' or 'viewed' (signed/declined/already-revoked
//     contracts are terminal and cannot be revoked)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractRevokeSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'

export const runtime = 'nodejs'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = contractRevokeSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data: contract, error: rErr } = await db
    .from('contracts')
    .select('id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!canTransition(contract.status, 'revoked')) {
    return NextResponse.json({
      success: false,
      error: `Cannot revoke a contract in status '${contract.status}'. Only unsigned contracts can be revoked.`,
    }, { status: 409 })
  }

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
      revoked_reason: parsed.data.revoked_reason,
    })
    .eq('id', contract.id)
    .in('status', ['issued', 'viewed', 'draft'])
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // TODO (commit 3): email + push to the recipient noting the
  // revocation + reason. Best-effort, don't block the response.

  return NextResponse.json({ success: true, data: updated })
}
