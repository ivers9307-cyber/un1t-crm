import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'

// DELETE /api/locations/[id]/holidays/[holidayId]
// Removes a custom holiday. Static national holidays are not stored in the
// table and therefore can't be deleted — the UI hides the delete button on
// `source: 'national'` rows.
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { error } = await db.from('location_holidays')
    .delete()
    .eq('id', params.holidayId)
    .eq('location_id', params.id)  // belt-and-braces — also constrain by parent

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
