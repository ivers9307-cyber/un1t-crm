// XERO-API.1 PR 1 — POST /api/locations/[id]/xero/sync-contacts.
//
// Sibling of /sync-accounts — same auth posture, same response
// shape. Contacts is the heavier sync (paginated, can hit
// thousands of rows) so we surface `pages` in the response too so
// the UI can show "synced 4 pages / 312 contacts" on completion.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { pullContacts } from '@/lib/xero/contacts-sync'
import { XeroError } from '@/lib/xero/client'
import { serverErrorResponse } from '@/lib/error-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth({ permission: null, location: 'param' }, async ({ request, locationId }) => {
  try {
    const result = await pullContacts(locationId)
    return NextResponse.json({
      success: true,
      syncedCount: result.syncedCount,
      deletedCount: result.deletedCount,
      syncedAt: result.syncedAt,
      pages: result.pages,
    })
  } catch (e) {
    const status = e instanceof XeroError && e.status
      ? Math.min(Math.max(e.status, 400), 599)
      : 500
    // OBS-HANDLED.1 — a failed Xero pull (including 401 token-death and
    // 429s, the classes that keep biting silently) now leaves an
    // error_events row. Same public body/status as before.
    return serverErrorResponse({
      module: 'xero-sync-contacts',
      error: e,
      request,
      status,
      publicMessage: e.message || 'Sync failed',
    })
  }
})
