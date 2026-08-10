-- 520 — LISTHEALTH-ACT.1: let an operator act on a `review` row.
--
-- WHY A MIGRATION AT ALL. mig 515 gave the list-health surface exactly one
-- verb: release. A `suppress` row can be undone, and a `review` row can be
-- dismissed, but the cohort the sweep deliberately refuses to auto-act on --
-- addresses that HAVE accepted mail before and then bounced across three or
-- more campaigns -- could only be actually suppressed by hand-writing SQL
-- against contacts.email_suppressed_at. That path writes no audit row, which
-- is the one thing mig 515 exists to prevent: "suppressing someone with no
-- recoverable reasoning is not acceptable".
--
-- The action is modelled the way the release route already models an undo:
-- close the existing row, open a new one. The alternative -- flipping the
-- review row's `decision` to 'suppress' in place -- would satisfy the CHECK
-- with no migration at all, but it would overwrite the fact that the rule said
-- review, and the release route already refuses to rewrite a closed row for
-- exactly that reason. An audit table you edit in place is a status column.
--
-- Closing the review row needs a reason, and neither existing value fits:
--
--   'operator'                  is load-bearing. bounce-escalation-sweep.js
--                               treats it as PERMANENT and never re-evaluates
--                               that contact again, because it means a human
--                               looked and said no. Reusing it here would
--                               record "a human said no" for a human who said
--                               yes, and would stop the sweep refreshing the
--                               counts on the suppression it just created.
--   'stamp_cleared_externally'  is the sweep tidying up after itself.
--
-- Hence a third value. It is additive: no existing row changes, no existing
-- read changes, and the two documented meanings above keep their meanings.
--
-- Undo is unchanged and needs no new code: the row the operator created is a
-- normal decision='suppress' row, so the existing release route closes it with
-- release_reason='operator' and clears the stamp, and the sweep's permanent
-- override then applies exactly as it would for an automatic suppression.

alter table email_bounce_escalations
  drop constraint if exists email_bounce_escalations_release_reason_check;

alter table email_bounce_escalations
  add constraint email_bounce_escalations_release_reason_check
  check (release_reason in ('operator', 'stamp_cleared_externally', 'operator_suppressed'));

comment on column email_bounce_escalations.release_reason is
  'operator = a human undid a suppression, permanent (the sweep never re-suppresses that contact). stamp_cleared_externally = the sweep closed the row because contacts.email_suppressed_at had been cleared by an open/click, a re-consent or a manual edit; that contact CAN be re-evaluated. operator_suppressed (mig 520) = a human escalated a review row to a suppression from the list health page; the review row closes and a new decision=suppress row carries the stamp, so the sweep is NOT permanently blocked and the new row is releasable like any other.';
