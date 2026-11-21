// src/app/api/accounting/mailboxes/route.js
//
// RCOV.P1 — hunt-inbox management: list + add. Mailboxes are scoped
// PER LOCATION (mig 374 — the hunt only searches a line against its
// own location's inboxes; each location is independent, no overlap),
// so these routes gate on accounting_hub AND the active location. The
// imap_password column is NEVER selected here — GET returns only the
// operator-facing metadata columns.
//
// withAuth only signs the caller in (its 401): its own permission and studio
// answers word the 403 and 400 differently, so accounting_hub (403 'Forbidden')
// and the active studio (400) stay below in their old order.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
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

export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const { data, error } = await db
    .from('recon_mailboxes')
    .select('id, label, email, active, last_ok_at, last_error, created_at')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
  if (error) {
    logError('accounting-mailboxes', 'list query failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the inboxes. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: data || [] })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
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
    // Never log credentials — only the Postgres code and message, never the
    // row that carried the password.
    logError('accounting-mailboxes', 'insert failed', { locationId, code: insErr.code ?? null, message: insErr.message })
    return NextResponse.json({ success: false, error: 'Could not add the inbox. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: created.id } })
})
