// WIDGET.1 — DELETE /api/widget/tokens/[id]: revoke one widget credential.
//
// SESSION-ONLY, same as the sibling list/mint route — no allowWidgetToken
// here either. A widget could otherwise revoke ITS OWN token and mint a
// fresh one via the sibling route (if that one ever gained the flag too),
// which would make revocation meaningless. Revoking happens from the
// phone app's authenticated session.
//
// Revoke STAMPS revoked_at rather than deleting the row: the row is the
// audit trail for every door, AC unit, plug and speaker that token could
// once reach, and that history has to outlive the credential (mig 607).
//
// 404, never 403, for a token that exists but is not the caller's own and
// the caller lacks staff_management — a distinct 403 would confirm the id
// exists, which is the enumeration this repo avoids everywhere else (see
// checklists/templates/[id], equipment/[id], and the file header comment
// on every other 404-not-403 detail route).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () =>
  NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export const DELETE = withAuth(
  { permission: null, location: true },
  async ({ user, db, params }) => {
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    }

    const { data: row, error: selectError } = await db
      .from('widget_tokens')
      .select('id, profile_id')
      .eq('id', id)
      .maybeSingle()
    if (selectError) {
      // Never hand a raw Postgres message to the client — log it, answer in
      // the operator's language, same as the sibling list/mint route.
      console.error('[widget/tokens/:id] lookup failed:', selectError.message)
      return NextResponse.json({ success: false, error: 'Could not revoke that widget.' }, { status: 500 })
    }
    if (!row) return notFound()

    // Own token: always allowed. Someone else's: staff_management only,
    // and denial still reads as "not found" — never a 403 that would
    // confirm the id belongs to a real row.
    if (row.profile_id !== user.id && !hasPermission(user, 'staff_management')) {
      return notFound()
    }

    // PostgREST does not error on a zero-row UPDATE — it returns
    // { data: [], error: null } — so the row count, not `error`, is what
    // decides success here. `.select('id')` (no `.single()`) is what makes
    // that count visible: a `.single()` UPDATE would instead throw on zero
    // rows, collapsing this into a 500 rather than the 404 a caller
    // racing a second revoke (or a since-deleted row) actually needs.
    const { data: updated, error: updateError } = await db
      .from('widget_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (updateError) {
      console.error('[widget/tokens/:id] revoke failed:', updateError.message)
      return NextResponse.json({ success: false, error: 'Could not revoke that widget.' }, { status: 500 })
    }
    if (!updated || updated.length === 0) return notFound()

    return NextResponse.json({ success: true })
  }
)
