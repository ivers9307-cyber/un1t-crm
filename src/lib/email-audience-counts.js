// MCPEMAIL.1 — the email audience head-count, moved out of
// /api/communications/audience-count so the route and the staff MCP tools
// read one definition. SEND-PARITY (COMMSFIX.B.5): `eligible` is the number a
// send would actually reach, from the shared send-path builder; `matched` is
// filter-only; `excluded` breaks down the gap. A failed count THROWS (never a
// silent zero): the route turns that into its 400, a tool into a refusal.
import { applyAudienceFilterAsync, scopedAudienceSource } from '@/lib/audience-filter'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'

export async function emailAudienceCounts(db, { filter, locationId }) {
  // Filter-scoped count over the per-location audience view, optionally
  // refined with extra gates. Single-table (mig 491 view), head:true safe.
  const viewCount = async (refine) => {
    const selectOpts = { count: 'exact', head: true }
    const gate = (source) => {
      const q = source.eq('audience_location_id', locationId)
      return refine ? refine(q) : q
    }
    const base = gate(db.from('contact_location_audience').select('id', selectOpts))
    // AUDIENCEIDS.1 — the same count on the view's scoped rpc twin (mig 795)
    // when the filter's id list does not fit the GET URL.
    const rebase = (sets) => gate(scopedAudienceSource(db, 'contact_location_audience', { locationId, ...sets, columns: 'id', selectOpts }))
    const { query: q } = await applyAudienceFilterAsync({ db, query: base, filter, locationId, rebase })
    const { count: c, error: e } = await q
    if (e) throw new Error(e.message)
    return c || 0
  }

  // Order matters — keep aligned with the route test's count sequence.
  const matched = await viewCount(null)
  const not_opted_in = await viewCount((q) => q.eq('loc_email_marketing', false))
  const bounced_or_complained = await viewCount((q) => q.in('email_status', ['bounced', 'complained']))
  // Marketing suppression (email_suppressed_at), gated on the PER-LOCATION
  // consent column: consented AND stamped, matching buildAudienceQuery's
  // marketing gate. NOENGSUP.1: bounces only.
  const suppressed = await viewCount((q) => q.eq('loc_email_marketing', true).not('email_suppressed_at', 'is', null))
  // The will-receive number comes from the EXACT send-path builder the
  // populate step uses, so it equals what a send would enrol and what the
  // preview lists.
  const { query: eligibleQuery } = await buildEligibleAudienceQuery({
    db, channel: 'email', filter, locationId,
    columns: 'id', selectOpts: { count: 'exact', head: true },
  })
  const { count: eligible, error: eligibleErr } = await eligibleQuery
  if (eligibleErr) throw new Error(eligibleErr.message)
  return {
    matched,
    eligible: eligible || 0,
    excluded: { not_opted_in, bounced_or_complained, suppressed },
  }
}
