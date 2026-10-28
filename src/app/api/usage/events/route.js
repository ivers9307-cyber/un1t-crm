// USAGE.1 — POST /api/usage/events: one app usage batch from a staff phone
// (Bearer JWT) or browser (session cookie). Design:
// docs/superpowers/specs/2026-10-26-app-usage-design.md.
//
// Who is recorded is decided HERE, not trusted from the client: a master, a
// "view as" session and a support session answer 200 { recorded: false }
// and write nothing (a 200, not a 204, so the phone's api() can parse it and
// the tracker drops the batch instead of retrying it). Members, tombstones
// and deactivated staff never get past getCurrentUser.
//
// Recording is best effort. A database error answers 503 with a logged
// error and the client keeps the batch (at most 10) for its next flush; it
// never surfaces to the person using the app.
//
// SECURITY: service-role writes, so RLS does nothing here. profile_id and
// location_id come from the session, never the body, and a session id that
// already belongs to someone else is refused (ingest.js).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { usageEventsSchema } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { shouldRecordFor, recordUsageBatch } from '@/lib/app-usage/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!shouldRecordFor(user)) {
    return NextResponse.json({ success: true, data: { recorded: false, reason: 'not_recorded' } })
  }

  const v = await validateBody(request, usageEventsSchema)
  if (!v.ok) return v.response

  try {
    const result = await recordUsageBatch({
      db: createServerClient(),
      profileId: user.id,
      locationId: user.activeLocation?.id || null,
      batch: v.data,
      nowMs: Date.now(),
    })
    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    logError('app-usage', 'usage batch not recorded', { message: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'Usage not recorded' }, { status: 503 })
  }
}
