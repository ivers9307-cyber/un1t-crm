// WIDGET.1 — GET/POST /api/widget/tokens: list a profile's live widget
// credentials, and mint a new one.
//
// SESSION-ONLY, DELIBERATELY. Neither handler below carries
// allowWidgetToken. A widget that could mint its own widget tokens would be
// a credential that renews itself straight past a revocation — and
// surviving revocation is the entire point a revocation exists (mig 607,
// src/lib/widget-token.js). Minting and revoking widget tokens happens from
// the phone app's authenticated session, never from the widget extension
// process itself.
//
// The plaintext token is returned exactly once, here, at mint time. Only
// its sha256 (token_hash) is ever stored — see mig 607's header — so GET's
// select list, and the explicit map below it, deliberately never include
// token_hash: a route that forwarded a raw row instead of this shape would
// leak the lookup key for every live credential.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { generateWidgetToken, hashWidgetToken } from '@/lib/widget-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const mintSchema = z.object({
  device_label: z.string().trim().min(1).max(60).optional(),
})

// GET /api/widget/tokens?profile_id=<uuid> — list of { id, device_label,
// created_at, last_used_at } for the named profile's LIVE (unrevoked)
// tokens. Defaults to the caller's own. Listing someone else's requires
// staff_management; without it this returns an empty list rather than an
// error or a 403 — same "don't confirm what you can't see" posture as the
// 404-not-403 detail routes elsewhere in this codebase.
export const GET = withAuth(
  { permission: null, location: true },
  async ({ user, db, request }) => {
    const { searchParams } = new URL(request.url)
    const requested = searchParams.get('profile_id')
    const targetId = requested || user.id

    if (targetId !== user.id && !hasPermission(user, 'staff_management')) {
      return NextResponse.json({ success: true, data: { tokens: [] } })
    }

    const { data, error } = await db
      .from('widget_tokens')
      .select('id, device_label, created_at, last_used_at')
      .eq('profile_id', targetId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    // Map explicitly rather than forwarding `data` wholesale — token_hash
    // must never reach a response regardless of what the select list above
    // says, or of what a future edit to it might say.
    const tokens = (data || []).map((row) => ({
      id: row.id,
      device_label: row.device_label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    }))
    return NextResponse.json({ success: true, data: { tokens } })
  }
)

// POST /api/widget/tokens { device_label? } — mint a new per-device
// credential, scoped to the caller and their active location. Returns
// { id, token } — token is the ONLY time the plaintext exists outside the
// device's App Group; it is never logged and never stored.
export const POST = withAuth(
  { permission: null, location: true, schema: mintSchema },
  async ({ user, db, locationId, input }) => {
    const token = generateWidgetToken()
    const tokenHash = hashWidgetToken(token)

    const { data, error } = await db
      .from('widget_tokens')
      .insert({
        profile_id: user.id,
        location_id: locationId,
        token_hash: tokenHash,
        device_label: input?.device_label ?? null,
      })
      .select('id')
      .single()
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { id: data.id, token } })
  }
)
