// RCOV.P2 — shared loader for the per-line coverage actions. Guards
// per house convention: session → accounting_hub → active location,
// then the line is looked up SCOPED to the active location — a miss
// is a 404 (never 403) so ids can't be enumerated.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'

export async function loadLineForUser(id) {
  const user = await getCurrentUser()
  if (!user) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!hasPermission(user, 'accounting_hub')) {
    return { response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { response: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }

  const db = createServerClient()
  const { data: line, error } = await db
    .from('recon_bank_lines')
    .select('id, location_id, status, description, amount, line_date, invoices_queue_id, hunt_attempts')
    .eq('id', id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) {
    return { response: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  }
  if (!line) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }
  return { user, db, locationId, line }
}
