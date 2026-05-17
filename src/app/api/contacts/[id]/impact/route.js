// GET /api/contacts/[id]/impact
//
// Returns counts of every dependent row, grouped by delete-rule.
// Used by the delete confirm dialog (so the operator sees what
// will be cascaded vs preserved) and by the merge confirm dialog
// (so they see what's about to fold across).
//
// Manager+ at the contact's location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { getContactImpact } from '@/lib/contact-merge'

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
  const { data: contact } = await db.from('contacts').select('id, location_id').eq('id', params.id).single()
  if (!contact) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  if (user.role !== 'master') {
    const userLocIds = (user.locations || []).map(l => l.id)
    if (!userLocIds.includes(contact.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const impact = await getContactImpact(db, params.id)
  return NextResponse.json({ success: true, data: impact })
}
