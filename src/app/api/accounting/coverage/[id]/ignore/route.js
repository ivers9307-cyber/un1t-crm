// RCOV.P2 — mark a bank line "ignored" (expected no-doc: bank fees,
// internal transfers, payouts). Clearing the hunt flags here is
// LOAD-BEARING: a line left queued would keep the drain cron's
// finalizer waiting and wedge the weekly report.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadLineForCaller } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_FROM = ['uncovered', 'not_found', 'needs_attention']

const IgnoreSchema = z.object({ reason: z.string().min(2).max(200) })

// withAuth only signs the caller in; loadLineForCaller keeps the hand-written
// gate (accounting_hub 'Forbidden' 403, active-location 400, line scoped to the
// active studio, 404) exactly as the sibling line routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  const ctx = await loadLineForCaller(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, line } = ctx

  const body = await validateBody(request, IgnoreSchema)
  if (!body.ok) return body.response

  if (!ALLOWED_FROM.includes(line.status)) {
    return NextResponse.json(
      { success: false, error: `Cannot ignore a line in '${line.status}' state.` },
      { status: 409 }
    )
  }

  const nowIso = new Date().toISOString()
  const { error } = await db
    .from('recon_bank_lines')
    .update({
      status: 'ignored',
      ignore_reason: body.data.reason,
      ignored_by: user.id,
      ignored_at: nowIso,
      hunt_queued_at: null,
      hunt_claimed_at: null,
      updated_at: nowIso,
    })
    .eq('id', line.id)
  if (error) {
    logError('recon-coverage', 'ignore failed', { err: error, lineId: line.id })
    return NextResponse.json({ success: false, error: 'Could not ignore the line.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
})
