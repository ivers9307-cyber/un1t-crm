// CAMPHIST.1 — the clone row for a duplicated campaign. Moved out of the
// duplicate route (MCPEMAIL.2) so the route and the MCP tool share one allowlist.

/**
 * The clone row. An allowlist, deliberately: a denylist would silently start
 * copying any history column a future migration adds, which is the exact class
 * of bug this route exists to close.
 *
 * `parent_campaign_id` is NOT set. It is reserved for non-opener resends and
 * carries `campaigns_one_resend_per_parent`, a UNIQUE index (mig 506) — a
 * duplicate that set it would both mislabel itself as a resend and make the
 * operator's second duplicate fail on a constraint they cannot see.
 *
 * @param {object} source  The campaigns row being copied.
 * @param {string} userId  Whoever pressed Duplicate.
 */
export function buildCampaignDuplicate(source, userId) {
  return {
    location_id: source.location_id,
    name: `Copy of ${source.name || 'Untitled Campaign'}`,
    subject: source.subject,
    preview_text: source.preview_text,
    from_name: source.from_name,
    from_email: source.from_email,
    reply_to: source.reply_to,
    design_json: source.design_json,
    html_content: source.html_content,
    audience_filter: source.audience_filter,
    template_id: source.template_id,
    postmark_stream: source.postmark_stream,
    // A/B SETUP carries; the decision does not. Re-running the same test on a
    // new audience is the point. ab_winner / ab_test_started_at /
    // ab_decided_at belong to the send that produced them.
    ab_subject_b: source.ab_subject_b,
    ab_test_pct: source.ab_test_pct,
    ab_wait_hours: source.ab_wait_hours,
    status: 'draft',
    // The copy is the duplicating operator's, not the original author's.
    created_by: userId,
  }
}
