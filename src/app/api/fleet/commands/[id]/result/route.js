// FLEET-CMD.1 — the agent reports what happened.
//
// POST /api/fleet/commands/[id]/result   Bearer fdv_…
//   { status: 'succeeded'|'failed'|'rejected', exit_code?, output?, error? }
//
// A narrow endpoint rather than letting the Pi write to Postgres directly.
// Writing results straight to the table would need an RLS UPDATE grant on the
// device's credential, which is a materially larger thing to hand a box
// sitting in a gym than "call one endpoint that only accepts an outcome for a
// command addressed to you".

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { verifyFleetDeviceToken } from '@/lib/fleet-device-auth'
import { validateBody } from '@/lib/validate'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// output is capped rather than unbounded: pull_logs (P2) sends journal lines,
// and an agent that misbehaves should not be able to push arbitrary volume
// into the database through this route.
const MAX_OUTPUT = 64 * 1024

const ResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'rejected']),
  exit_code: z.number().int().min(-256).max(256).nullable().optional(),
  output: z.string().max(MAX_OUTPUT).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()

  const device = await verifyFleetDeviceToken(request, db)
  if (!device) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, ResultSchema)
  if (!validation.ok) return validation.response
  const { status, exit_code, output, error } = validation.data

  // Ownership is enforced in the WHERE clause, not by reading first and
  // comparing: a device may only complete a command addressed to it, and
  // only one it has actually claimed. A row that fails either test simply
  // updates nothing.
  const { data: updated, error: updateError } = await db
    .from('fleet_commands')
    .update({
      status,
      exit_code: exit_code ?? null,
      output: output ?? null,
      error: error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('device_name', device.device_name)
    .eq('status', 'claimed')
    .select('id, action, status')
    .maybeSingle()

  if (updateError) {
    logWarn('fleet-cmd', 'failed to record result', {
      device: device.device_name, id: params.id, err: updateError,
    })
    return NextResponse.json({ ok: false, error: 'Could not record result' }, { status: 500 })
  }

  // 404 covers all of: wrong device, unknown id, already finished, or expired
  // out from under the agent. Not distinguishing them is deliberate — a device
  // credential should not be able to probe which command ids exist.
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  logInfo('fleet-cmd', 'command finished', {
    device: device.device_name, action: updated.action, status, exit_code,
  })

  return NextResponse.json({ ok: true })
}
