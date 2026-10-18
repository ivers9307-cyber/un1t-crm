// POST /api/whatsapp/broadcasts/[id]/sign-off — WAORGNUMBER.4 (spec R7).
// An organisation admin (master passes) signs off a draft or scheduled
// broadcast someone else made, so it may go out while its studio's blast
// sign-off window (locations.settings.whatsapp_blast_signoff_until) is open.
// Stamps whatsapp_broadcasts.signed_off_by / signed_off_at (mig 748); sends
// nothing. The body names the content the admin saw ({ content_key }, the
// page's signedContentKey): a broadcast changed since is a 409, so a sign-off
// never covers content its admin did not see. A later content change by
// anyone else clears the stamp (PUT).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, assertOrganizationAdmin } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { readSignoffLocation, signedContentKey, SIGNED_CONTENT_FIELDS } from '@/lib/whatsapp-blast-signoff'

const SignOffSchema = z.object({ content_key: z.string().min(1).max(64) })

const SIGNABLE = ['draft', 'scheduled']
const waForbidden = () => NextResponse.json(
  { success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) return waForbidden()

  const validation = await validateBody(request, SignOffSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: row, error: rowErr } = await db.from('whatsapp_broadcasts')
    .select(`id, location_id, status, updated_at, ${SIGNED_CONTENT_FIELDS.join(', ')}`)
    .eq('id', params.id)
    .maybeSingle()
  if (rowErr) return NextResponse.json({ success: false, error: 'Could not read the broadcast' }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, row.location_id, 'whatsapp')) return waForbidden()

  let location
  try {
    location = await readSignoffLocation(db, row.location_id)
  } catch {
    return NextResponse.json({ success: false, error: "Could not read the broadcast's studio. Try again." }, { status: 503 })
  }
  const adminGuard = assertOrganizationAdmin(user, location?.organization_id || null)
  if (adminGuard) {
    return NextResponse.json({ success: false, error: 'Only an organisation admin can sign off a broadcast.' }, { status: 403 })
  }

  if (!SIGNABLE.includes(row.status)) {
    return NextResponse.json({
      success: false,
      error: `Broadcast is in '${row.status}' state, so it cannot be signed off`,
    }, { status: 409 })
  }

  if (signedContentKey(row) !== validation.data.content_key) {
    return NextResponse.json({
      success: false,
      error: 'This broadcast has changed since you opened it. Reload the page, check it, and sign it off again.',
    }, { status: 409 })
  }

  // Compare-and-swap on the state it was judged in: the status (the cron may
  // promote a scheduled row) and updated_at (bumped by trigger on every write,
  // so an edit landing after the read above is never signed off unseen).
  const { data, error } = await db.from('whatsapp_broadcasts')
    .update({ signed_off_by: user.id, signed_off_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .eq('updated_at', row.updated_at)
    .select('id, signed_off_by, signed_off_at')
  if (error) return NextResponse.json({ success: false, error: 'Could not record the sign-off' }, { status: 500 })
  if (!data?.length) {
    return NextResponse.json({
      success: false,
      error: 'The broadcast changed while you were signing it off. Reload the page and try again.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, broadcast: data[0] })
}
