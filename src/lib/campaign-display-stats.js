// REPORT-SOT.2 — campaign_recipients is the single DISPLAYED source.
//
// THE PROBLEM. campaigns.total_* and campaign_recipients disagree about the
// same campaign, and every operator surface read the counters. The counters
// are written by recalculate_campaign_stats (mig 157), which counts
// email_sends. A SEND-TIME REJECTION (Postmark 300 invalid address / 406
// inactive recipient) never produces an email_sends row at all —
// campaign-sender writes it straight onto campaign_recipients as
// status='bounced', bounce_type='rejected'. Every rejection is therefore
// invisible to the counter and present on the recipient row.
//
// Measured live 2026-08-10 across the 14 sent campaigns:
//
//     campaign                    total_bounced   recipients bounced
//     Hatch Street Announcement              14                   54
//     Email 12 Jun 22:50                      5                   42
//     Email 12 Jun 23:18                      0                   40
//     Train for FREE (5 Aug)                  4                   41
//     Email 8 Aug 21:11                       2                   21
//     Summer sale recovery (9 Aug)            4                   27
//
// A campaign reporting ZERO bounces that actually refused 40 addresses is the
// single worst kind of wrong number this product can show: it is the figure an
// operator would use to decide the sending domain is healthy.
//
// ⚠️ THE STORED COUNTERS ARE NOT BEING REPAIRED AND NOT BEING DROPPED.
// Explicit product decision: leave the history on disk, change what is
// displayed. Nothing in this module writes. recalculate_campaign_stats and
// increment_campaign_metric run exactly as before, and CampaignEditor's
// mid-send progress bar deliberately keeps reading campaigns.total_sent /
// total_recipients — it polls through the RLS-bound BROWSER client, which
// cannot execute a service_role-only rpc, and a per-tick progress number is
// the one job the counters are genuinely good at.
//
// WHICH SOURCE PRODUCED THE NUMBER IS ALWAYS KNOWN. `source` is 'recipients'
// normally and 'counters' only when the rpc failed. The surfaces label the
// fallback rather than presenting the second source as if it were the first:
// showing both at once is the ambiguity this change exists to remove, and
// showing the wrong one silently is how it started.

const num = (v) => Number(v || 0)

/** What a caller passes when it has no recipient figures at all. */
export const NO_RECIPIENT_STATS = Object.freeze({ ok: false, byCampaign: new Map(), error: null })

const ZERO = Object.freeze({
  recipients: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
  bounced: 0, complained: 0, unsubscribed: 0, failed: 0,
})

/** 0.4387 -> '43.9%'. Null or a zero denominator reads as '0%', as before. */
export function pct(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return '0%'
  const v = Number(rate) * 100
  return v === 0 ? '0%' : `${v.toFixed(1)}%`
}

const rateOf = (hits, denom) => (denom > 0 ? hits / denom : null)

/**
 * Fetch per-campaign figures from campaign_recipients for a batch of ids.
 *
 * ONE call for the whole batch. /communications/sent lists up to 100
 * campaigns; a call per campaign would be 100 round trips on a page render,
 * and count-only selects would be six each.
 *
 * The 1,000-row cap does not bite: the rpc aggregates in Postgres and returns
 * one row per campaign, never one per recipient.
 *
 * @param {object} db            service-role supabase client
 * @param {Array<string>} ids    campaign ids, already resolved through a
 *                               location-scoped query by the caller (the rpc
 *                               applies no tenant filter of its own)
 * @returns {Promise<{ ok: boolean, byCampaign: Map<string, object>, error: string|null }>}
 */
export async function loadCampaignRecipientStats(db, ids) {
  const clean = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== '')
  if (!clean.length) return { ok: true, byCampaign: new Map(), error: null }

  let data = null
  let error = null
  try {
    // supabase-js builders are thenables, not Promises: they have .then but no
    // .catch, so the try/catch has to wrap the await rather than hang off it.
    ;({ data, error } = await db.rpc('campaign_recipient_stats', { p_campaign_ids: clean }))
  } catch (e) {
    error = { message: e?.message || 'campaign_recipient_stats threw' }
  }
  if (error) {
    console.error('[campaign stats] campaign_recipient_stats failed:', error.message)
    return { ok: false, byCampaign: new Map(), error: error.message }
  }
  return {
    ok: true,
    byCampaign: new Map((data || []).map((r) => [r.campaign_id, r])),
    error: null,
  }
}

/**
 * The figures a surface renders for one campaign.
 *
 * A campaign ABSENT from a successful result is a real zero, not a missing
 * answer: the rpc groups by campaign_id, so a campaign with no recipient rows
 * simply has none. Substituting the stored counter there would put the
 * disagreement straight back on screen for exactly the campaigns where the two
 * sources differ most.
 *
 * @param {object} campaign  the campaigns row (for the counters fallback)
 * @param {object|null} stats  the result of loadCampaignRecipientStats
 */
export function campaignDisplayStats(campaign, stats) {
  const c = campaign || {}
  const counts = stats?.ok
    ? { ...ZERO, ...(stats.byCampaign.get(c.id) || {}) }
    : {
        // The counters, read exactly as the surfaces read them before this
        // change — including the total_sent-or-total_recipients denominator,
        // so a fallback render is the old behaviour and not a third answer.
        recipients: num(c.total_recipients),
        sent: num(c.total_sent) || num(c.total_recipients),
        delivered: num(c.total_delivered),
        opened: num(c.total_opened),
        clicked: num(c.total_clicked),
        bounced: num(c.total_bounced),
        complained: num(c.total_complained),
        unsubscribed: num(c.total_unsubscribed),
        failed: 0,
      }

  const sent = num(counts.sent)
  // REPORT-SOT.3 — delivered is the ONE figure campaign_recipients cannot
  // always stand behind. delivered_at is stamped by the Postmark Delivery
  // webhook, which was not recording it until June 2026: coverage runs 1.2%
  // for May (36 rows of 2,998), 97.5% June, 99.3% July, 63.4% August. So a
  // raw switch would print "36 delivered" beside "777 opened" on the May
  // campaign, which is worse than the counter it replaced and visibly
  // self-contradicting.
  //
  // The test is provable inconsistency, not a coverage guess: an email cannot
  // be opened without being delivered, so delivered < opened means the
  // delivered count is INCOMPLETE — no threshold to tune and no per-month
  // cutoff to maintain. Such a campaign reports delivered: null, and the
  // surface says "not recorded" rather than a number nobody can stand behind.
  // Every other figure still comes from campaign_recipients; this is the same
  // posture readOutcome and the list-health trend already take.
  const deliveredRaw = num(counts.delivered)
  const deliveredIsComplete = deliveredRaw >= num(counts.opened)
  return {
    source: stats?.ok ? 'recipients' : 'counters',
    recipients: num(counts.recipients),
    sent,
    delivered: deliveredIsComplete ? deliveredRaw : null,
    delivered_incomplete: !deliveredIsComplete,
    opened: num(counts.opened),
    clicked: num(counts.clicked),
    bounced: num(counts.bounced),
    complained: num(counts.complained),
    unsubscribed: num(counts.unsubscribed),
    failed: num(counts.failed),
    // Rates are computed on the DISPLAYED denominator, never on a stored one,
    // so the percentage and the count beside it can never tell different
    // stories.
    open_rate: rateOf(num(counts.opened), sent),
    click_rate: rateOf(num(counts.clicked), sent),
    bounce_rate: rateOf(num(counts.bounced), sent),
  }
}
