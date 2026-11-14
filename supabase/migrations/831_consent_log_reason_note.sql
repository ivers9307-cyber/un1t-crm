-- 831 — STAFFCONSENT.1: a reason and a note on consent_log, for staff changes.
-- (docs/superpowers/specs/2026-11-14-staff-studio-consent-design.md; plan task 1.)
--
-- NOT APPLIED when this file was written. Applying is a rollout step for
-- Richard's go-ahead; apply it BEFORE the code that depends on it deploys
-- (POST /api/contacts/[id]/studio-consent writes both columns).
--
-- WHY: staff can now switch a contact's marketing email on or off for one
-- studio, and must say why (Richard, 14 Nov 2026). The reason is one of a
-- fixed list (in_person, phone, email, signed_form, other) checked by the
-- route; the note is free text, at most 500 characters, required for 'other'.
-- Both are nullable: no other consent writer sets them.
--
-- consent_log is closed to every client session since mig 662 (no privilege,
-- RLS on, no policy). This file grants nothing and adds no policy, so the new
-- columns are closed too.
--
-- column-grant: consent_log is not a column-granted table (no client privilege at all).
-- column-grant: withheld consent_log.reason
-- column-grant: withheld consent_log.note

ALTER TABLE public.consent_log
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.consent_log.reason IS
  'STAFFCONSENT.1 (mig 831): why staff made this change (in_person | phone | email | signed_form | other). NULL for every non-staff writer.';
COMMENT ON COLUMN public.consent_log.note IS
  'STAFFCONSENT.1 (mig 831): staff note, at most 500 characters; required when reason = other.';
