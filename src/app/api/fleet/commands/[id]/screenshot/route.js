// FLEET-CMD.3 — the agent posts back what the screen is showing.
//
// POST /api/fleet/commands/[id]/screenshot   Bearer fdv_…
//   Content-Type: image/jpeg, body = raw bytes
//
// Separate from the JSON result route because this is binary and large: the
// result endpoint caps `output` at 64KB of TEXT, and base64 in a JSON body
// would inflate a board capture by a third for no reason.
//
// Completing the command is part of THIS request. The agent does not post a
// result separately — a screenshot whose bytes never arrived is not a success,
// so the upload and the status transition have to be the same event.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyFleetDeviceToken } from '@/lib/fleet-device-auth'
import { logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Matches the bucket's own limit (mig 477). A 1080p JPEG of a leaderboard is
// well under 500KB; anything near this ceiling is a bug or an abuse.
const MAX_BYTES = 5 * 1024 * 1024

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()

  const device = await verifyFleetDeviceToken(request, db)
  if (!device) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const bytes = Buffer.from(await request.arrayBuffer())
  if (!bytes.length) {
    return NextResponse.json({ ok: false, error: 'Empty body' }, { status: 400 })
  }
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'Too large' }, { status: 413 })
  }
  // Verify it really is a JPEG rather than trusting the header — this writes
  // to a bucket, and the content type is attacker-controlled.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return NextResponse.json({ ok: false, error: 'Not a JPEG' }, { status: 400 })
  }

  // Ownership in the WHERE clause: a device may only complete a screenshot
  // addressed to it, and only one it actually claimed.
  const { data: command } = await db
    .from('fleet_commands')
    .select('id, action')
    .eq('id', params.id)
    .eq('device_name', device.device_name)
    .eq('status', 'claimed')
    .eq('action', 'screenshot')
    .maybeSingle()

  // 404 for wrong device, unknown id, already finished or expired — never
  // distinguishing them, so a device credential cannot probe command ids.
  if (!command) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  // Path carries the device and the command id, so a prune can find them by
  // prefix and a stray object is always traceable to the action that made it.
  const path = `${device.device_name}/${command.id}.jpg`
  const { error: uploadError } = await db.storage
    .from('fleet-screenshots')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: true })

  if (uploadError) {
    logWarn('fleet-cmd', 'screenshot upload failed', {
      device: device.device_name, err: uploadError,
    })
    // Record the failure on the command so the UI says something truthful
    // rather than leaving it to expire silently.
    await db.from('fleet_commands').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: 'could not store the screenshot',
    }).eq('id', command.id)
    return NextResponse.json({ ok: false, error: 'Upload failed' }, { status: 500 })
  }

  await db.from('fleet_commands').update({
    status: 'succeeded',
    exit_code: 0,
    screenshot_path: path,
    finished_at: new Date().toISOString(),
  }).eq('id', command.id)

  logInfo('fleet-cmd', 'screenshot stored', {
    device: device.device_name, bytes: bytes.length,
  })

  return NextResponse.json({ ok: true })
}
