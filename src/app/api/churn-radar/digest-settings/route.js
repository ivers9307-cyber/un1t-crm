// GET / PUT /api/churn-radar/digest-settings
//
// RADAR-DIGEST.1 — read + edit the email recipients for the weekly
// churn-radar digest. Recipients live in locations.churn_digest_
// recipients (text[]); an empty list means the digest is off.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'

// recipients is optional — an empty array is valid (disables the digest)
const DigestSettingsSchema = z.object({
  recipients: z.array(z.string()).optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_RECIPIENTS = 20

// Shared auth + active-location resolution. Returns { locationId } or
// { error: NextResponse }.
async function guard() {
  const user = await getCurrentUser()
  if (!user) {
    return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!hasPermission(user, 'churn_radar')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }
  return { locationId }
}

export async function GET() {
  const g = await guard()
  if (g.error) return g.error
  const db = createServerClient()
  const { data, error } = await db
    .from('locations')
    .select('churn_digest_recipients')
    .eq('id', g.locationId)
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    success: true,
    data: { recipients: data?.churn_digest_recipients || [] },
  })
}

export async function PUT(request) {
  const g = await guard()
  if (g.error) return g.error

  const v = await validateBody(request, DigestSettingsSchema, { allowEmpty: true })
  if (!v.ok) return v.response
  const body = v.data
  const raw = Array.isArray(body?.recipients) ? body.recipients : []

  // Sanitise: trim, lowercase, validate shape, dedupe.
  const seen = new Set()
  const recipients = []
  for (const r of raw) {
    if (typeof r !== 'string') continue
    const email = r.trim().toLowerCase()
    if (!email) continue
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { success: false, error: `Not a valid email address: ${r}` },
        { status: 400 },
      )
    }
    if (seen.has(email)) continue
    seen.add(email)
    recipients.push(email)
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      { success: false, error: `Too many recipients (max ${MAX_RECIPIENTS})` },
      { status: 400 },
    )
  }

  const db = createServerClient()
  const { error } = await db
    .from('locations')
    .update({ churn_digest_recipients: recipients })
    .eq('id', g.locationId)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { recipients } })
}
