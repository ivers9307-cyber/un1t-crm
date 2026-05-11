-- ============================================================
-- 134: contacts.dob — date of birth (GLOFOX2.1.2).
--
-- Originally needed to make the birthday-wishes sequence
-- template work (it uses anniversary trigger with from_field=
-- 'dob'), and to capture the Glofox `birth` field during the
-- member sync.
--
-- DATE not TIMESTAMPTZ — birthdays are TZ-agnostic; storing
-- a timestamp would invite "Roisin's birthday is tomorrow vs.
-- today depending on whether you're east or west of UTC at
-- query time" bugs. The anniversary trigger compares date
-- parts, not instants.
--
-- Nullable — most existing contacts won't have dob. Glofox's
-- `birth` field is also commonly null (members aren't required
-- to provide it during signup). Operator can edit on the
-- contact form when they collect it.
-- ============================================================

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS dob DATE;

COMMENT ON COLUMN public.contacts.dob IS
  'Date of birth (TZ-agnostic). Powers the birthday-wishes anniversary sequence template + future "members turning 30 this month" reports. Nullable. Mig 134 (GLOFOX2.1.2).';

COMMIT;
