// PILLAR2 Phase 1 — live "how many contacts match" count for the unified send
// surface. Single-table counts (head:true returns the TRUE count, uncapped);
// avoids the brittle embedded-resource count-under-inner-join (see CLAUDE.md
// PostgREST lesson).
//
// COMMSFIX.B.5 — the email and SMS branches are SEND-PARITY: `count` is the
// number the send would actually reach (per-location consent + status +
// suppression via contact_location_audience, exactly like populate), with
// `matched` (filter-only) and an `excluded` breakdown alongside — the
// WhatsApp branch has worked this way all along and is the template. The old
// channel-agnostic email/SMS count overstated the audience ~2.5x (raw
// contacts at the location, no gates) and its email 'suppressed' sub-count
// read the retired GLOBAL contacts.email_marketing column.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { applyAudienceFilterAsync } from '@/lib/audience-filter'
import { computeWhatsAppReachabilitySummary } from '@/lib/whatsapp'
import { buildAudienceQueryAsync } from '@/lib/postmark'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  audience_filter: z.unknown().optional(),
  channel: z.enum(['sms', 'whatsapp', 'email']).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, audience_filter, channel } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()
  try {
    if (channel === 'whatsapp') {
      // Single-table reachability counts (safe post mig 422) — keep the pre-send
      // number honest about WhatsApp consent + a usable wa_phone.
      const { matched, reachable, excluded } =
        await computeWhatsAppReachabilitySummary(db, audience_filter || { logic: 'and', filters: [] }, location_id)
      return NextResponse.json({ success: true, count: matched, reachable, excluded })
    }
    const filter = audience_filter || { logic: 'and', filters: [] }

    // Filter-scoped count over the per-location audience view, optionally
    // refined with extra gates. Single-table (mig 491 view), head:true safe.
    const viewCount = async (refine) => {
      let base = db
        .from('contact_location_audience')
        .select('id', { count: 'exact', head: true })
        .eq('audience_location_id', location_id)
      if (refine) base = refine(base)
      const { query: q } = await applyAudienceFilterAsync({ db, query: base, filter, locationId: location_id })
      const { count: c, error: e } = await q
      if (e) throw new Error(e.message)
      return c || 0
    }

    if (channel === 'email') {
      // Order matters — keep aligned with the route test's count sequence.
      const matched = await viewCount(null)
      const not_opted_in = await viewCount((q) => q.eq('loc_email_marketing', false))
      const bounced_or_complained = await viewCount((q) => q.in('email_status', ['bounced', 'complained']))
      // EMAIL-HYGIENE.1 — inactivity suppression (email_suppressed_at, mig
      // 395), gated on the PER-LOCATION consent column (the old sub-count
      // read the retired global contacts.email_marketing): consented AND
      // stamped, matching buildAudienceQuery's marketing gate.
      const suppressed = await viewCount((q) => q.eq('loc_email_marketing', true).not('email_suppressed_at', 'is', null))
      // The will-receive number comes from the EXACT send-path builder the
      // populate step uses (view + loc_email_marketing + email_status +
      // suppression), so this count equals what a send would enrol.
      const { query: eligibleQuery } = await buildAudienceQueryAsync(db, filter, location_id, {
        columns: 'id',
        selectOpts: { count: 'exact', head: true },
      })
      const { count: eligible, error: eligibleErr } = await eligibleQuery
      if (eligibleErr) return NextResponse.json({ success: false, error: eligibleErr.message }, { status: 400 })
      return NextResponse.json({
        success: true,
        count: eligible || 0,   // eligible / will receive (back-compat key)
        matched,                // filter-only
        suppressed,             // back-compat top-level key (pre-B5 consumers)
        excluded: { not_opted_in, bounced_or_complained, suppressed },
      })
    }

    if (channel === 'sms') {
      // Mirror the SMS send gate (sms.js smsAudienceBase): per-location
      // consent + active sms_status + a phone number. Order matters — keep
      // aligned with the route test's count sequence.
      const matched = await viewCount(null)
      const eligible = await viewCount((q) => q.eq('loc_sms_marketing', true).eq('sms_status', 'active').not('phone', 'is', null))
      const no_phone = await viewCount((q) => q.is('phone', null))
      const not_opted_in = await viewCount((q) => q.eq('loc_sms_marketing', false))
      const opted_out = await viewCount((q) => q.neq('sms_status', 'active'))
      return NextResponse.json({
        success: true,
        count: eligible,        // eligible / will receive (back-compat key)
        matched,
        excluded: { no_phone, not_opted_in, opted_out },
      })
    }

    // No channel — the original channel-agnostic raw-contacts count (kept
    // for callers that want filter reach, not deliverability).
    // Count on the FIRST .select() (postgrest-js only reads head/count there).
    const baseQuery = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', location_id)
    // Async path resolves virtual fields (event_registration + tag) into the
    // contacts.id constraint before counting — the sync filter silently skips them.
    const { query } = await applyAudienceFilterAsync({
      db,
      query: baseQuery,
      filter,
      locationId: location_id,
    })
    const { count, error } = await query
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

    return NextResponse.json({ success: true, count: count || 0 })
  } catch (e) {
    // applyAudienceFilter throws InvalidAudienceFilterError on a non-whitelisted
    // (field, op) — surface it as a 400 rather than a 500.
    return NextResponse.json({ success: false, error: e?.message || 'Could not count audience' }, { status: 400 })
  }
}
