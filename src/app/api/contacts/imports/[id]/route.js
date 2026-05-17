// GET /api/contacts/imports/[id]
//
// Drill-in for one batch — returns the batch envelope + every
// per-row outcome. Manager+ at the batch's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: batch } = await db
    .from('contact_imports')
    .select('*, actor:profiles!contact_imports_actor_user_id_fkey(full_name, email)')
    .eq('id', params.id)
    .single()
  if (!batch) return NextResponse.json({ success: false, error: 'Import not found' }, { status: 404 })

  const guard = assertLocationAccess(user, batch.location_id)
  if (guard) return guard

  const { data: rows } = await db
    .from('contact_import_rows')
    .select('id, row_number, action, contact_id, raw_row, error_message')
    .eq('import_id', params.id)
    .order('row_number', { ascending: true })
    .limit(5000)

  return NextResponse.json({ success: true, data: { batch, rows: rows || [] } })
}
