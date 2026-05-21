-- 195_contact_membership_state.sql
--
-- CHURN-RADAR — capture the Glofox membership lifecycle state.
--
-- `glofox_membership_status` (already present) is the Glofox Client
-- Status — member / trial / lead / credit_member. It does NOT say
-- whether the membership itself is currently running.
--
-- The Glofox member payload carries that separately on
-- member.membership.status — ACTIVE / PAUSED / CANCELLED / EXPIRED.
-- A member whose membership is PAUSED is on a planned freeze
-- (holiday, injury), not at churn risk — without this field the
-- churn radar flags them as "gone quiet" incorrectly.
--
-- Stored lowercase, mirroring glofox_membership_status. Populated by
-- the daily glofox-attendance-refresh cron.

alter table public.contacts
  add column if not exists glofox_membership_state text;

comment on column public.contacts.glofox_membership_state is
  'Glofox membership lifecycle state (member.membership.status), lowercased — active / paused / cancelled / expired. Distinct from glofox_membership_status (the Client Status). Null for PAYG / leads with no membership.';
