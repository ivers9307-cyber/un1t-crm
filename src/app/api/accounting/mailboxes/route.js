// src/app/api/accounting/mailboxes/route.js
//
// RCOV.P1 — hunt-inbox management: list + add. Mailboxes are scoped
// PER LOCATION (mig 374 — the hunt only searches a line against its
// own location's inboxes; each location is independent, no overlap),
// so these routes gate on accounting_hub AND the active location. The
// imap_password column is NEVER selected here — GET returns only the
// operator-facing metadata columns.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { verifyMailboxLogin } from '@/lib/recon/imap-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MailboxCreateSchema = z.object({
  label: z.string().min(1).max(100),
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('recon_mailboxes')
    .select('id, label, email, active, last_ok_at, last_error, created_at')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[accounting/mailboxes] list query failed:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const result = await validateBody(request, MailboxCreateSchema)
  if (!result.ok) return result.response
  const { label, email, password } = result.data

  // Live login check before we ever persist the credential — an
  // inbox that can't authenticate is worse than no inbox (it'd sit
  // there failing silently until someone opens the card).
  const verify = await verifyMailboxLogin({ email, password })
  if (!verify.ok) {
    return NextResponse.json(
      { success: false, error: `IMAP login failed: ${verify.error}` },
      { status: 400 }
    )
  }

  const db = createServerClient()
  const { data: created, error: insErr } = await db
    .from('recon_mailboxes')
    .insert({
      location_id: locationId,
      label,
      email,
      imap_password: password,
      created_by: user.id,
      last_ok_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (insErr) {
    if (insErr.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'This inbox is already added to this location.' },
        { status: 409 }
      )
    }
    // Never log credentials — insErr.message is a Postgres error
    // string, not the password, but log defensively anyway.
    console.error('[accounting/mailboxes] insert failed:', insErr.message)
    return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: created.id } })
}
