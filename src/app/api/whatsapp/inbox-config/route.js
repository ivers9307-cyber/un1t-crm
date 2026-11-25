import { NextResponse } from 'next/server'
import { assertLocationAccess, requireInboxPermission } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { createServerClient } from '@/lib/supabase'
import { readInboxFollowupConfig } from '@/lib/inbox-followup-config'

// GET /api/whatsapp/inbox-config?location_id= — INBOXFOLLOW.4. A studio's inbox
// follow-up config ({ quietHours, nudgeEnabled }). The phone reads the WhatsApp
// list straight from the database, so it cannot get the config the web list
// route returns alongside its rows; it asks here instead. Gated exactly like the
// WhatsApp list route: the inbox permission (which the phone's key satisfies)
// and membership of the studio. withAuth only signs the caller in.
export const GET = withAuth({ permission: null, location: false }, async ({ user, request }) => {
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const data = await readInboxFollowupConfig(createServerClient(), locationId)
  return NextResponse.json({ success: true, data })
})
