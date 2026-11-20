// GET /api/contacts/[id]/impact
//
// Returns counts of every dependent row, grouped by delete-rule.
// Used by the delete confirm dialog (so the operator sees what
// will be cascaded vs preserved) and by the merge confirm dialog
// (so they see what's about to fold across).
//
// Manager+ at the contact's primary studio, an organisation admin, or a master
// (ORGCONTACTS.4: the same decision as DELETE).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasRoleAtAnyLocation } from '@/lib/auth'
import { canDeleteOrRehomeContact } from '@/lib/contact-edit-gates'
import { isOrgAdminSomewhere } from '@/lib/org-admin'
import { MANAGER_ROLES } from '@/lib/schemas'
import { getContactImpact } from '@/lib/contact-merge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MANAGER_REQUIRED = 'Manager+ required'

// ROLESWEEP.1c — coarse pre-check (allow); the decision is made at the contact
// below. ORGCONTACTS.4: an organisation admin may hold no studio role at all.
export const GET = withAuth(
  {
    permission: null,
    location: false,
    allow: (user) => hasRoleAtAnyLocation(user, MANAGER_ROLES) || isOrgAdminSomewhere(user),
    forbiddenMessage: MANAGER_REQUIRED,
  },
  async ({ user, db, params }) => {
    const id = params?.id
    const { data: contact } = await db.from('contacts').select('id, location_id, organization_id').eq('id', id).single()
    if (!contact) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
    // ORGCONTACTS.4 — the same decision as DELETE (this is its confirm dialog):
    // the primary studio's admins, an organisation admin, or a master.
    if (!canDeleteOrRehomeContact({ user, contact })) {
      return NextResponse.json({ success: false, error: MANAGER_REQUIRED }, { status: 403 })
    }

    const impact = await getContactImpact(db, id)
    return NextResponse.json({ success: true, data: impact })
  },
)
