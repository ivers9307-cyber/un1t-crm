// POST /api/presentations/[id]/advance  { index }  → set current_index, bump version
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { clampIndex } from '@/lib/presentations'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ index: z.number().int() })
const NOT_AUTHORISED = 'Not authorised for presentations'

// `presentations` somewhere (403), the body (400), then the deck's studio (404)
// and `presentations` there (403), as before. A signed-out call is a 401 now.
export const POST = withAuth(
  { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'presentations'), forbiddenMessage: NOT_AUTHORISED },
  async ({ user, db, request, params }) => {
    const id = params?.id
    const validation = await validateBody(request, Schema)
    if (!validation.ok) return validation.response
    const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
    if (!deck || assertLocationAccess(user, deck.location_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    // ROLESWEEP.1a — the permission is judged at the deck's location.
    if (!hasPermissionForLocation(user, deck.location_id, 'presentations')) {
      return NextResponse.json({ success: false, error: NOT_AUTHORISED }, { status: 403 })
    }
    const { count } = await db.from('presentation_slides')
      .select('id', { count: 'exact', head: true }).eq('presentation_id', id)
    const next = clampIndex(validation.data.index, count || 0)
    const { data, error } = await db
      .rpc('bump_presentation_version', { p_presentation_id: id, p_current_index: next })
      .single()
    if (error) {
      logError('presentations', 'advance failed', { presentationId: id, err: error })
      return NextResponse.json({ success: false, error: 'Could not move the deck on. Try again.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, current_index: data.current_index, version: data.version })
  },
)
