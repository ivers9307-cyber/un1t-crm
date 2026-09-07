-- HOST-RESEND.1 — "Resend to those who missed it" on the host report page.
--
-- WHY. A sent campaign can be re-launched for the contacts who never got a
-- 'sent' row (POST /api/host/emails/[id]/resend-missed → launchHostCampaign
-- trigger 'resend_missed'). The queue's finaliser used to overwrite sent_at
-- on every drain, so a resend erased the campaign's real send time (the 7
-- Sep 2026 hand-run resend of f831e89f did exactly that). From this
-- migration on, sent_at is written only while null and a later drain lands
-- on resent_at instead. The report header reads "Sent <first>" and, when
-- present, "Resent <latest>". Per-send rows keep their own sent_at, so the
-- recipient table needs nothing new.

alter table host_campaigns
  add column if not exists resent_at timestamptz;

comment on column host_campaigns.resent_at is
  'HOST-RESEND.1: when the latest resend finished draining; sent_at keeps the FIRST send and is never overwritten. Null until the campaign has been resent.';
