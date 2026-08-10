-- 518 — BOUNCEDAT.1: give send-time rejections a timestamp.
--
-- THE DEFECT
-- campaign-sender's permanent-rejection branch (Postmark 300 invalid email /
-- 406 inactive recipient) wrote status='bounced' + bounce_type='rejected' but
-- never bounced_at. The Postmark *webhook* path has always written all three.
-- So a bounce recorded by the sender is invisible to every reader keyed on the
-- timestamp — the contact timeline's Bounced chip, /api/sequences/[id]/stats'
-- bounce count, integration-health's `.not('bounced_at','is',null)` — while
-- still being counted by anything keyed on status or bounce_type. Live: 42
-- rejection events over 11 contacts, 38 of them with no timestamp.
--
-- The code fix (this migration's sibling commit) stamps bounced_at going
-- forward. This migration deals with the rows already on disk.
--
-- WHAT TIMESTAMP TO BACKFILL — the investigation
--
--   * campaign_recipients has NO updated_at column. Checked against
--     information_schema on the live DB, not assumed: mig 005 created the
--     table without one and no later migration added one. So the obvious
--     candidate does not exist.
--   * sent_at is NULL on all 42 rejected rows — by definition, the send never
--     happened.
--   * created_at is populate time, which is BEFORE the send. It is a lower
--     bound on the rejection, not the rejection.
--   * claimed_at (mig 392) is stamped by the queued->sending CAS claim of the
--     tick that made the send attempt. 'bounced' is terminal, so the LAST
--     claim on the row IS the attempt that got rejected, and the rejection
--     landed within that tick — seconds later. This is a real per-row
--     observation of the event, not a reconstruction. 19 of the 38 rows have
--     one; on every one of them claimed_at falls inside its campaign's send
--     window (verified against campaigns.sent_at and min/max
--     email_sends.created_at per campaign).
--
-- The other 19 rows predate mig 392 (campaigns of 2026-05-13 .. 2026-06-20)
-- and carry no claimed_at. The only thing left for them is a CAMPAIGN-level
-- bound: campaigns.sent_at, or the min/max of email_sends.created_at for that
-- campaign. Those windows are 2-8 minutes wide, and using either would stamp
-- the SAME fabricated instant on every rejected row of a campaign, stored in
-- the same column and indistinguishable from a timestamp a provider actually
-- reported. That is inventing a time, so those 19 rows are DELIBERATELY LEFT
-- NULL. A NULL that reads as "we do not know when" is honest; a plausible
-- wrong instant on a delivery-evidence row is not, and nothing downstream is
-- fixed by it — the repeat-bounce sweep and mig 515's
-- email_bounce_type_summary both key on bounce_type precisely so a missing
-- timestamp cannot hide a rejection (that design is unchanged and still
-- load-bearing for these 19).
--
-- Net effect: 19 rows gain a defensible timestamp, 19 stay NULL, 4 already
-- had one and are untouched by the IS NULL guard.
--
-- Forward-only. Idempotent (the guards make a re-run a no-op). Data-only, no
-- DDL — no new advisor surface, but run get_advisors after applying anyway.

update public.campaign_recipients
   set bounced_at = claimed_at
 where bounce_type = 'rejected'
   and bounced_at is null
   and claimed_at is not null;

comment on column public.campaign_recipients.bounced_at is
  'When the bounce/rejection was observed. Written by the Postmark Bounce webhook and, since BOUNCEDAT.1, by campaign-sender''s permanent-rejection branch. NULL on 19 pre-mig-392 rejected rows whose exact instant is unrecoverable (mig 518) — never treat NULL as "did not bounce"; key on bounce_type for that.';
