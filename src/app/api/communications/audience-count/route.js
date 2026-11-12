// PILLAR2 Phase 1 — live "how many contacts match" count for the unified send
// surface. Single-table counts (head:true returns the TRUE count, uncapped);
// avoids the brittle embedded-resource count-under-inner-join (see CLAUDE.md
// PostgREST lesson).
//
// COMMSFIX.B.5 — the email branch is SEND-PARITY: `count` is the
// number the send would actually reach (per-location consent + status +
// suppression via contact_location_audience, exactly like populate), with
// `matched` (filter-only) and an `excluded` breakdown alongside — the
// WhatsApp branch has worked this way all along and is the template. The old
// channel-agnostic email count overstated the audience ~2.5x (raw
// contacts at the location, no gates) and its email 'suppressed' sub-count
// read the retired GLOBAL contacts.email_marketing column.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { applyAudienceFilterAsync, scopedAudienceSource } from '@/lib/audience-filter'
import { computeWhatsAppReachabilitySummary } from '@/lib/whatsapp'
// FILTER-B.8 — the will-receive number for EVERY channel comes from the
// shared per-channel eligibility builder (buildEligibleAudienceQuery), which
// delegates to that channel's SEND builder. The email branch reaches it through
// emailAudienceCounts (src/lib/email-audience-counts.js, MCPEMAIL.1), shared
// with the MCP email tools; /api/communications/audience-preview uses the same
// builder, so the count, the preview and the send resolve one query path by
// construction. (The SMS branch that lived here, and taught this lesson by
// hand-copying its send gates, left with the SMS channel — TWILIO-RETIRE.1.)
import { emailAudienceCounts } from '@/lib/email-audience-counts'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  audience_filter: z.unknown().optional(),
  channel: z.enum(['whatsapp', 'email']).optional(),
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
      // FILTER-C.5 — `reachable` (the will-receive number) is now built by
      // buildWhatsAppAudienceAsync, the same send builder
      // buildEligibleAudienceQuery delegates to for this channel, so all three
      // channels take their will-receive number from their own send path. Fixed
      // inside the helper rather than here on purpose: the blast writes the
      // same summary to whatsapp_broadcasts.delivery_summary, and a route-only
      // fix would have left that second consumer on the old definition.
      //
      // Note the RESPONSE SHAPE is deliberately different from email and is
      // not being changed here: `count` is the MATCH set and `reachable` the
      // will-receive set, which AudienceCount reads channel-by-channel
      // (sendable = reachable for WhatsApp, count everywhere else). Renaming
      // them to match would move a number that hosts gate Send on.
      const { matched, reachable, excluded } =
        await computeWhatsAppReachabilitySummary(db, audience_filter || { logic: 'and', filters: [] }, location_id)
      return NextResponse.json({ success: true, count: matched, reachable, excluded })
    }
    const filter = audience_filter || { logic: 'and', filters: [] }

    if (channel === 'email') {
      // MCPEMAIL.1 — the head-count lives in @/lib/email-audience-counts (the
      // MCP campaign tools read it too). It throws on a failed count; the
      // catch below turns that into the same 400 + message as before.
      const { matched, eligible, excluded } = await emailAudienceCounts(db, { filter, locationId: location_id })
      return NextResponse.json({
        success: true,
        count: eligible,        // eligible / will receive (back-compat key)
        matched,                // filter-only
        suppressed: excluded.suppressed,   // back-compat top-level key (pre-B5 consumers)
        excluded,
      })
    }

    // No channel — the channel-agnostic MATCH count (filter reach, not
    // deliverability): the contacts with a relationship at the studio
    // (studio_contacts, mig 765), the same set audience-eligibility.js
    // builds for the sequence preview and enrolment. ORGCONTACTS.4: the stage
    // field lands on studio_stage_slug, which the raw contacts table lacks.
    // Count on the FIRST .select() (postgrest-js only reads head/count there).
    const matchOpts = { count: 'exact', head: true }
    const baseQuery = db.from('studio_contacts').select('id', matchOpts).eq('studio_location_id', location_id)
    // Async path resolves virtual fields (event_registration + tag) into the
    // contacts.id constraint before counting — the sync filter silently skips them.
    // AUDIENCEIDS.1 — on studio_contacts' scoped rpc twin (mig 795) when the id
    // list does not fit the GET URL.
    const { query } = await applyAudienceFilterAsync({
      db,
      query: baseQuery,
      filter,
      locationId: location_id,
      rebase: (sets) => scopedAudienceSource(db, 'studio_contacts', { locationId: location_id, ...sets, columns: 'id', selectOpts: matchOpts })
        .eq('studio_location_id', location_id),
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
