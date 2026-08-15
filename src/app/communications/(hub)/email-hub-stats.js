// COMMSFIX.C.6 — the /communications hub's email stats.
//
// Extracted from page.js so the FILTERS are testable (the page holds JSX in a
// .js file, which the repo's node-environment vitest cannot import). Two bugs
// lived here, both structural rather than intermittent:
//
//   • "Active sequences" read email_sequences.active — the DEAD column. `status`
//     is truth (established invariant), and live data has active=false on the
//     sequence whose status IS 'active'. This was the last reader of the column
//     left in the repo.
//
//   • "Open rate" divided EVERY email_sends row at the location into the opened
//     ones. Since EMAIL-NOTRACK.1 (2026-08-07) TrackOpens is explicitly off for
//     every non-broadcast stream, so ticket replies, invoices and sequences'
//     administrative mail can never register an open yet still inflate the
//     denominator — the number drifts down as transactional volume grows, for a
//     reason nobody reading it can see. Both halves now filter to the broadcast
//     stream, which is the only mail that CAN report an open.
//
// Note postmark_stream lives on email_sends, not campaigns (CLAUDE.md — that
// exact assumption once caused a prod 500).

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db — service-role client
 * @param {string} locationId
 * @returns {Promise<{ totalSent: number, totalOpened: number, openRate: number, activeSequences: number }>}
 */
export async function loadEmailHubStats(db, locationId) {
  const [{ count: sent }, { count: opened }, { count: seqCount }] = await Promise.all([
    db.from('email_sends').select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('postmark_stream', 'broadcast'),
    db.from('email_sends').select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('postmark_stream', 'broadcast')
      .not('opened_at', 'is', null),
    db.from('email_sequences').select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', 'active'),
  ])

  const totalSent = sent || 0
  const totalOpened = opened || 0
  return {
    totalSent,
    totalOpened,
    openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0,
    activeSequences: seqCount || 0,
  }
}
