// RCOV.P2 — reverse an ignore: the line returns to 'uncovered' and
// re-enters normal hunting/seeding on the next cycle.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadLineForCaller } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; loadLineForCaller keeps the hand-written
// gate (accounting_hub 'Forbidden' 403, active-location 400, line scoped to the
// active studio, 404) exactly as the sibling line routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await loadLineForCaller(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, line } = ctx

  if (line.status !== 'ignored') {
    return NextResponse.json(
      { success: false, error: `Only ignored lines can be un-ignored (this one is '${line.status}').` },
      { status: 409 }
    )
  }

  const nowIso = new Date().toISOString()
  const { error } = await db
    .from('recon_bank_lines')
    .update({
      status: 'uncovered',
      ignore_reason: null,
      ignored_by: null,
      ignored_at: null,
      updated_at: nowIso,
    })
    .eq('id', line.id)
  if (error) {
    logError('recon-coverage', 'unignore failed', { err: error, lineId: line.id })
    return NextResponse.json({ success: false, error: 'Could not un-ignore the line.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
})
