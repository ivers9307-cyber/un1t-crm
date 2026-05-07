// /api/contracts/[id]/decline
//
// Recipient declines their own contract with a reason.
//
// Allowed only when:
//   - caller is the contract's recipient (profile_id match)
//   - status is 'issued' or 'viewed'
//
// Terminal: declined contracts cannot be undone. The issuer can
// re-issue with a new contract row if the situation changes.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractDeclineSchema } from '@/lib/schemas'
import { canTransition } from '@/lib/contracts'
import { sendContractDeclinedEmail } from '@/lib/contracts-email'

export const runtime = 'nodejs'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const raw = await request.json().catch(() => ({}))
  const parsed = contractDeclineSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data: contract, error: rErr } = await db
    .from('contracts')
    .select('id, profile_id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ success: false, error: rErr.message }, { status: 500 })
  if (!contract) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (contract.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the recipient can decline this contract.' }, { status: 403 })
  }
  if (!canTransition(contract.status, 'declined')) {
    return NextResponse.json({
      success: false,
      error: `Cannot decline a contract in status '${contract.status}'.`,
    }, { status: 409 })
  }

  const { data: updated, error: updErr } = await db
    .from('contracts')
    .update({
      status: 'declined',
      declined_at: new Date().toISOString(),
      declined_reason: parsed.data.declined_reason,
    })
    .eq('id', contract.id)
    .in('status', ['issued', 'viewed'])
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ success: false, error: 'Contract status changed concurrently — refresh and retry.' }, { status: 409 })
  }

  // Notify issuer — best effort.
  const { data: detail } = await db
    .from('contracts')
    .select(`
      id,
      profile:profiles!profile_id (full_name, email),
      issuer:profiles!issued_by (full_name, email),
      template:contract_templates!template_id (name)
    `)
    .eq('id', updated.id)
    .maybeSingle()

  const emailResult = await sendContractDeclinedEmail({
    contract: updated,
    recipient: detail?.profile,
    issuer: detail?.issuer,
    templateName: detail?.template?.name,
  })

  return NextResponse.json({
    success: true,
    data: updated,
    warning: emailResult.ok ? undefined : `Decline recorded but issuer email failed: ${emailResult.error}`,
  })
}
