// FILTER-B.6 — "show me who matches".
//
// Until this route, only a COUNT existed anywhere in the product: no surface
// listed which contacts a filter selects, so the only way to check an audience
// was to send to it. This is the single change most likely to have caught the
// 8 August mis-targeting before it went out.
//
// Two properties are load-bearing, and neither is optional:
//
//  1. SAME QUERY PATH. The preview never builds its own query. It calls
//     buildEligibleAudienceQuery, which delegates to the per-channel SEND
//     builder — buildAudienceQueryAsync for email, buildSmsAudienceAsync for
//     SMS, buildWhatsAppAudienceAsync for WhatsApp — and the count route's
//     will-receive number comes from the same call. A preview that disagreed
//     with the send would be worse than no preview: it would manufacture
//     false confidence in the exact moment an operator is checking their work.
//
//  2. IT RETURNS CUSTOMER PII. Service-role routes bypass RLS entirely
//     (CLAUDE.md), so the tenant boundary is app code or it does not exist:
//     assertLocationAccessOr404, which 404s rather than 403s so location ids
//     cannot be enumerated. Rows are paginated (≤50) and masked, and there is
//     deliberately NO export — an export of a marketing audience is a
//     different feature with different consent implications.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'
import { toPreviewRow, PREVIEW_COLUMNS, PREVIEW_PAGE_SIZE, PREVIEW_MAX_PAGE_SIZE } from '@/lib/audience-preview'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  location_id: uuidLike,
  audience_filter: z.unknown().optional(),
  channel: z.enum(['sms', 'whatsapp', 'email']).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, audience_filter, channel, limit, offset } = validation.data

  // PII gate, before a single row is read. 404 not 403 — see CLAUDE.md.
  const guard = assertLocationAccessOr404(user, location_id)
  if (guard) return guard

  // A preview is a spot-check. Clamping the page is what keeps this from
  // quietly becoming the export it must not be.
  const pageSize = Math.min(Number(limit) || PREVIEW_PAGE_SIZE, PREVIEW_MAX_PAGE_SIZE)
  const start = Math.max(Number(offset) || 0, 0)

  const db = createServerClient()
  const filter = audience_filter || { logic: 'and', filters: [] }

  try {
    // count:'exact' rides the FIRST select() inside the send builder, so the
    // page and the total come from ONE query — they cannot disagree with each
    // other, and neither can disagree with the send.
    const { query } = await buildEligibleAudienceQuery({
      db,
      channel: channel || null,
      filter,
      locationId: location_id,
      columns: PREVIEW_COLUMNS,
      selectOpts: { count: 'exact' },
    })
    // Deterministic order, or page 2 can repeat or skip people.
    const { data, count, error } = await query
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

    return NextResponse.json({
      success: true,
      data: {
        rows: (data || []).map(r => toPreviewRow(r, channel || null)),
        total: count || 0,
        offset: start,
        limit: pageSize,
        channel: channel || null,
        // Say out loud which question this answers. With a channel these are
        // the people who would ACTUALLY receive the send (consent + status +
        // suppression applied); without one it is the match set — which is
        // the only honest answer for a sequence, whose audience is a
        // continuing condition rather than a recipient list (SEQEXIT.1).
        basis: channel ? 'will_receive' : 'matching',
      },
    })
  } catch (e) {
    // InvalidAudienceFilterError on a non-whitelisted (field, op) is the
    // operator's filter being wrong, not the server failing — 400, not 500.
    return NextResponse.json({ success: false, error: e?.message || 'Could not preview audience' }, { status: 400 })
  }
}
