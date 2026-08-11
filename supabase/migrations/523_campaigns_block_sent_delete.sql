-- ============================================================
-- 523 — CAMPDEL.1 — a sent campaign cannot be deleted
--
-- ⚠️ NOT YET APPLIED. Apply it with or after this PR's code deploys.
--
-- Ordering is free either way: this is purely additive and NOTHING in the
-- application depends on it. The app-level guards (the 409 on
-- DELETE /api/campaigns/[id] and the pre-delete status re-read in
-- CampaignEditor.handleDelete) are what close the hole for the two paths that
-- actually exist today. This trigger is the backstop for everything else, and
-- the app behaves identically whether or not it has been applied.
--
-- After applying, run get_advisors for BOTH types (security + performance).
--
-- ─── WHY A DATABASE-LEVEL GUARD AT ALL ─────────────────────────────────────
-- Mig 522 Section B learned this for UPDATE and the same reasoning applies
-- unchanged to DELETE: CampaignEditor writes the `campaigns` row DIRECTLY from
-- the browser Supabase client, so no /api route guard constrains it, and
-- campaigns_location_scoped (mig 014) is
-- `FOR ALL TO authenticated USING auth_is_in_location(location_id)` with no
-- status predicate, so the database allows the delete too. Section B's trigger
-- is BEFORE UPDATE only, which left the strictly larger hole open: an edit
-- corrupts the creative that a report describes, a delete removes the report.
--
-- ─── WHAT WOULD ACTUALLY HAVE BEEN DESTROYED ───────────────────────────────
-- Confirmed against the live database on 2026-08-11:
--
--   campaign_recipients.campaign_id   ON DELETE CASCADE   → gone
--   campaign_link_clicks.campaign_id  ON DELETE CASCADE   → gone
--   email_sends.campaign_id           ON DELETE SET NULL  → survives, orphaned
--   campaigns.parent_campaign_id      ON DELETE SET NULL  → resend loses lineage
--   unsubscribe_refusals.campaign_id  ON DELETE SET NULL  → survives, orphaned
--
-- Live totals at the time of writing: 15 sent campaigns holding 22,337
-- campaign_recipients rows (14 timestamp/status columns each) and 1,273
-- recorded clicks. Deleting one sent campaign takes its share of that with it,
-- irreversibly, and it exists nowhere else. The reporting RPCs added by migs
-- 513/517/521 read exactly these rows.
--
-- ─── THE RULE ──────────────────────────────────────────────────────────────
-- Deletable only while the campaign is still a plan: 'draft' or 'scheduled'.
-- Mirrors EDITABLE_CAMPAIGN_STATUSES in src/lib/campaign-editability.js and
-- the status list in campaigns_lock_sent_content (mig 522) — keep all three in
-- step. Fails CLOSED on an unrecognised status, because campaigns.status is
-- plain TEXT with no CHECK (mig 005): treating an unknown value as deletable
-- risks the irreversible outcome, treating it as locked costs an operator one
-- support message. Take the recoverable error.
--
-- NOTE this deliberately has no "unless you really mean it" escape hatch. A
-- genuine need to remove a sent campaign from an operator's list is an ARCHIVE
-- concern (a hidden/archived flag plus a list filter), which preserves the
-- record; it is not a delete, and it does not exist yet. Deleting through
-- psql to work around this trigger destroys the same rows the trigger exists
-- to protect.
-- ============================================================

CREATE OR REPLACE FUNCTION public.campaigns_block_sent_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('draft', 'scheduled') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Campaign % is % and cannot be deleted. Its recipients, opens and clicks are the record of what was actually sent, and campaign_recipients / campaign_link_clicks cascade with it.',
    OLD.id, COALESCE(OLD.status, 'in an unknown state')
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS campaigns_block_sent_delete ON campaigns;
CREATE TRIGGER campaigns_block_sent_delete
  BEFORE DELETE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.campaigns_block_sent_delete();

COMMENT ON FUNCTION public.campaigns_block_sent_delete() IS
  'CAMPDEL.1 — refuses deletion of a campaign past draft/scheduled. Completes mig 522 Section B, which guarded UPDATE only; campaign_recipients and campaign_link_clicks are ON DELETE CASCADE, so a delete destroyed the send record outright.';

-- HRPREF-AUTH.1 — the HR-email preference endpoint now logs its refusals to
-- the same table, so the documented value set widens. Comment only; the column
-- has no CHECK constraint (only `reason` does), so nothing else changes.
COMMENT ON COLUMN unsubscribe_refusals.endpoint IS
  'Which public consent endpoint refused: unsubscribe | preferences | hr-emails.';
