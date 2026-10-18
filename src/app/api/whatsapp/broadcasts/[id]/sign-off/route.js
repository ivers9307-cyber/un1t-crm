// POST /api/whatsapp/broadcasts/[id]/sign-off — WAORGNUMBER.4 (spec R7).
// An organisation admin (master passes) signs off a draft or scheduled
// broadcast someone else made, so it may go out while its studio's blast
// sign-off window (locations.settings.whatsapp_blast_signoff_until) is open.
// Stamps whatsapp_broadcasts.signed_off_by / signed_off_at (mig 748); sends
// nothing. A later content change by anyone else clears the stamp (PUT).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, assertOrganizationAdmin } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { readSignoffLocation } from '@/lib/whatsapp-blast-signoff'

const SIGNABLE = ['draft', 'scheduled']
const waForbidden = () => NextResponse.json(
  { success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) return waForbidden()

  const db = createServerClient()
  const { data: row, error: rowErr } = await db.from('whatsapp_broadcasts')
    .select('id, location_id, status')
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

  // Compare-and-swap on the status it was judged in (the cron may promote a
  // scheduled row in between).
  const { data, error } = await db.from('whatsapp_broadcasts')
    .update({ signed_off_by: user.id, signed_off_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
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
